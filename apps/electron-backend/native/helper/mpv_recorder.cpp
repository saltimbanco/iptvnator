/*
 * iptvnator_mpv_recorder: headless libmpv process that captures one live
 * stream to MPEG-TS files with mpv's `stream-record`, for background
 * recording on Windows. Driven by BackgroundRecordingService
 * (apps/electron-backend/src/app/services/background-recording.service.ts);
 * see docs/architecture/background-recording.md.
 *
 * stdin (one command per line, the frame helper's encoding: tab-separated
 * fields, first the name, then key=value with percent-encoded values):
 *   open    url=…  path=…  [user-agent=…] [referrer=…] [headers=…]
 *           headers is mpv's http-header-fields list ("K: V,K2: V2").
 *   stop              close the file and end playback, then emit `stopped`
 *   quit              stop and exit
 * stdin EOF (parent died) behaves like quit. The URL and headers never
 * travel on argv.
 *
 * stdout: one JSON event per line: ready, opened, recording {path},
 * buffering {active}, ended {reason, error}, stopped, record-failed {error},
 * log {level, prefix, text}, fatal {error}.
 *
 * One process records one file: the service starts a new process for the
 * next file after a reconnect, because mpv restarts the timestamps of every
 * `stream-record` file anyway.
 */
#include <mpv/client.h>

#include <atomic>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

#include "frame_helper_io.h"

using frame_helper::Command;
using frame_helper::emitLine;
using frame_helper::JsonWriter;

namespace {

mpv_handle* g_mpv = nullptr;
std::atomic<bool> g_running{true};
std::atomic<bool> g_stopRequested{false};
/* True while a file is open; record-failed is reported once per file. */
std::atomic<bool> g_fileOpen{false};

void setOption(const char* key, const char* value) {
    const int result = mpv_set_option_string(g_mpv, key, value);
    if (result < 0) {
        emitLine(JsonWriter()
                     .str("event", "log")
                     .str("level", "warn")
                     .str("text", std::string("option ") + key + ": " +
                                      mpv_error_string(result))
                     .finish());
    }
}

int setProperty(const char* key, const std::string& value) {
    return mpv_set_property_string(g_mpv, key, value.c_str());
}

void startRecordingFile(const std::string& path) {
    const int result = setProperty("stream-record", path);
    if (result < 0) {
        emitLine(JsonWriter()
                     .str("event", "log")
                     .str("level", "error")
                     .str("text", std::string("stream-record: ") +
                                      mpv_error_string(result))
                     .finish());
        return;
    }
    g_fileOpen.store(true);
    emitLine(JsonWriter().str("event", "recording").str("path", path).finish());
}

void handleOpen(const Command& command) {
    const std::string url = command.get("url");
    const std::string path = command.get("path");
    if (url.empty() || path.empty()) {
        emitLine(JsonWriter()
                     .str("event", "log")
                     .str("level", "error")
                     .str("text", "open needs url and path")
                     .finish());
        return;
    }
    g_stopRequested.store(false);
    setProperty("user-agent", command.get("user-agent"));
    setProperty("referrer", command.get("referrer"));
    setProperty("http-header-fields", command.get("headers"));
    startRecordingFile(path);
    const char* args[] = {"loadfile", url.c_str(), "replace", nullptr};
    mpv_command_async(g_mpv, 0, args);
}

void handleStop() {
    g_stopRequested.store(true);
    g_fileOpen.store(false);
    /* Clearing stream-record closes and flushes the file synchronously. */
    setProperty("stream-record", "");
    const char* args[] = {"stop", nullptr};
    mpv_command(g_mpv, args);
    emitLine(JsonWriter().str("event", "stopped").finish());
}

void runStdinLoop() {
    std::string line;
    while (g_running.load() && std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        const Command command = frame_helper::parseCommandLine(line);
        if (command.name == "open") {
            handleOpen(command);
        } else if (command.name == "stop") {
            handleStop();
        } else if (command.name == "quit") {
            break;
        }
    }
    if (!g_stopRequested.load()) handleStop();
    g_running.store(false);
    mpv_wakeup(g_mpv);
}

const char* endReason(int reason) {
    switch (reason) {
        case MPV_END_FILE_REASON_EOF: return "eof";
        case MPV_END_FILE_REASON_STOP: return "stop";
        case MPV_END_FILE_REASON_QUIT: return "quit";
        case MPV_END_FILE_REASON_ERROR: return "error";
        case MPV_END_FILE_REASON_REDIRECT: return "redirect";
        default: return "unknown";
    }
}

void runEventLoop() {
    while (g_running.load()) {
        mpv_event* event = mpv_wait_event(g_mpv, 1.0);
        switch (event->event_id) {
            case MPV_EVENT_NONE:
                break;
            case MPV_EVENT_FILE_LOADED:
                emitLine(JsonWriter().str("event", "opened").finish());
                break;
            case MPV_EVENT_END_FILE: {
                auto* end = static_cast<mpv_event_end_file*>(event->data);
                JsonWriter writer;
                writer.str("event", "ended").str("reason", endReason(end->reason));
                if (end->reason == MPV_END_FILE_REASON_ERROR) {
                    writer.str("error", mpv_error_string(end->error));
                }
                emitLine(writer.finish());
                break;
            }
            case MPV_EVENT_PROPERTY_CHANGE: {
                auto* prop = static_cast<mpv_event_property*>(event->data);
                if (prop->format == MPV_FORMAT_FLAG &&
                    std::string(prop->name) == "paused-for-cache") {
                    emitLine(JsonWriter()
                                 .str("event", "buffering")
                                 .boolean("active", *static_cast<int*>(prop->data) != 0)
                                 .finish());
                }
                break;
            }
            case MPV_EVENT_LOG_MESSAGE: {
                auto* msg = static_cast<mpv_event_log_message*>(event->data);
                std::string text = msg->text ? msg->text : "";
                while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) {
                    text.pop_back();
                }
                /* Never echo URLs: provider URLs can embed credentials. */
                if (text.find("://") != std::string::npos) text = "[redacted url line]";
                /* Setting stream-record succeeds even when the file cannot be
                 * created; mpv only logs this once the demuxer starts, then
                 * keeps playing without recording. Surface it as an event. */
                if (msg->prefix && std::string(msg->prefix) == "recorder" &&
                    msg->level && std::string(msg->level) == "error" &&
                    g_fileOpen.exchange(false)) {
                    emitLine(JsonWriter()
                                 .str("event", "record-failed")
                                 .str("error", text)
                                 .finish());
                }
                emitLine(JsonWriter()
                             .str("event", "log")
                             .str("level", msg->level ? msg->level : "")
                             .str("prefix", msg->prefix ? msg->prefix : "")
                             .str("text", text)
                             .finish());
                break;
            }
            case MPV_EVENT_SHUTDOWN:
                g_running.store(false);
                break;
            default:
                break;
        }
    }
}

} // namespace

int main() {
    g_mpv = mpv_create();
    if (!g_mpv) {
        emitLine(JsonWriter().str("event", "fatal").str("error", "mpv_create failed").finish());
        return 1;
    }
    /* Capture only: keep the tracks selected so stream-record writes them,
     * but render and play nothing, and skip as much decoding as possible. */
    setOption("vo", "null");
    setOption("ao", "null");
    setOption("vd-lavc-skipframe", "all");
    setOption("vd-lavc-skiploopfilter", "all");
    setOption("hwdec", "no");
    setOption("osc", "no");
    setOption("input-default-bindings", "no");
    setOption("terminal", "no");
    setOption("idle", "yes");
    setOption("keep-open", "no");
    setOption("cache", "yes");
    setOption("demuxer-max-bytes", "64MiB");
    setOption("network-timeout", "15");
    setOption("stream-lavf-o",
              "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,"
              "reconnect_delay_max=5");
    if (mpv_initialize(g_mpv) < 0) {
        emitLine(JsonWriter().str("event", "fatal").str("error", "mpv_initialize failed").finish());
        return 1;
    }
    mpv_request_log_messages(g_mpv, "warn");
    mpv_observe_property(g_mpv, 0, "paused-for-cache", MPV_FORMAT_FLAG);
    emitLine(JsonWriter().str("event", "ready").finish());

    std::thread stdinThread(runStdinLoop);
    runEventLoop();
    if (stdinThread.joinable()) stdinThread.detach();
    mpv_terminate_destroy(g_mpv);
    return 0;
}
