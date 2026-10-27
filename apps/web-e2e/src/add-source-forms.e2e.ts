import type { Locator, Page } from '@playwright/test';
import { setInputValue } from './e2e-helpers';
import { expect, test } from './fixtures';
import {
    XTREAM_MOCK_SERVER,
    interceptPwaProviderRequests,
    resetPwaMockServers,
} from './sources-pwa.helpers';

/**
 * The three add-source forms share one vocabulary: the same name label, a
 * masked password with a show/hide toggle, a URL error of their own and the
 * single "Add playlist" submit. Credentials are the Xtream mock's fixtures.
 */
test.beforeEach(async ({ page, request }) => {
    await resetPwaMockServers(request);
    await interceptPwaProviderRequests(page);
    await page.goto('/');
});

async function openMethod(page: Page, method: RegExp): Promise<Locator> {
    await page.getByRole('button', { name: 'Add playlist' }).click();
    const dialog = page.locator('mat-dialog-container');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: method }).click();
    return dialog;
}

async function expectPasswordToggle(dialog: Locator): Promise<void> {
    const password = dialog.locator('#password');
    const toggle = dialog.getByRole('button', { name: 'Show password' });

    await expect(password).toHaveAttribute('type', 'password');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(password).toHaveAttribute('type', 'password');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
}

test('@sources @pwa adds an Xtream source through the dialog', async ({
    page,
}) => {
    const dialog = await openMethod(page, /Xtream credentials/i);
    const serverUrl = dialog.locator('#serverUrl');

    await expect(
        dialog.getByText('Server address, e.g. http://host:port')
    ).toBeVisible();
    await setInputValue(serverUrl, 'panel.example');
    await serverUrl.blur();
    await expect(dialog.locator('mat-error')).toHaveText(
        'Enter a valid http:// or https:// URL.'
    );
    // The field used to borrow the EPG source error.
    await expect(dialog.getByText(/absolute file path/i)).toHaveCount(0);

    await setInputValue(
        dialog.getByRole('textbox', { name: 'Playlist title' }),
        'Dialog Xtream Source'
    );
    await setInputValue(serverUrl, XTREAM_MOCK_SERVER);
    await expect(dialog.locator('mat-error')).toHaveCount(0);
    await setInputValue(dialog.locator('#username'), 'user1');
    await setInputValue(dialog.locator('#password'), 'pass1');
    await expectPasswordToggle(dialog);
    await expect(dialog.locator('#password')).toHaveValue('pass1');

    const add = dialog.getByRole('button', {
        name: 'Add playlist',
        exact: true,
    });
    await expect(add).toBeEnabled({ timeout: 10_000 });
    await add.click();
    await expect(dialog).toBeHidden();
    await page.waitForURL(/xtreams.*vod/);
});

test('@sources @pwa explains an invalid M3U playlist URL', async ({ page }) => {
    const dialog = await openMethod(page, /M3U URL/i);
    const url = dialog.getByRole('textbox', {
        name: 'Playlist URL (m3u, m3u8)',
    });

    await expect(
        dialog.getByRole('textbox', { name: 'Playlist title' })
    ).toBeVisible();
    await setInputValue(url, 'playlist.m3u');
    await url.blur();

    await expect(dialog.locator('mat-error')).toHaveText(
        'Enter a valid http:// or https:// URL.'
    );
    await expect(
        dialog.getByRole('button', { name: 'Add playlist', exact: true })
    ).toBeDisabled();
});

test('@sources @pwa gives the Stalker form the shared labels and a masked password', async ({
    page,
}) => {
    const dialog = await openMethod(page, /Stalker portal/i);

    await expect(
        dialog.getByRole('textbox', { name: 'Playlist title' })
    ).toBeVisible();
    await expect(
        dialog.getByRole('textbox', { name: 'MAC address', exact: true })
    ).toBeVisible();
    await expect(dialog.locator('#password')).toBeHidden();
    await dialog.locator('app-stalker-portal-import summary').click();
    await setInputValue(dialog.locator('#password'), 'secret');
    await expectPasswordToggle(dialog);
    await expect(
        dialog.getByRole('button', { name: 'Add playlist', exact: true })
    ).toBeVisible();
});

test('@sources @pwa offers bulk import in the initial setup wizard', async ({
    page,
}) => {
    await page.goto('/workspace/sources');
    await expect(page.locator('.welcome-sources')).toBeVisible();
    const card = page
        .locator('.source-card')
        .filter({ hasText: /Bulk import/i });
    await expect(card).toBeVisible();
    await card.getByRole('button').click();

    const dialog = page.locator('mat-dialog-container');
    await expect(dialog).toBeVisible();
    // The picked card opens straight into the bulk form.
    await expect(
        dialog.getByRole('button', { name: /Load from file/i })
    ).toBeVisible();
});

test('@sources @pwa bulk-imports two M3U URLs with per-row VOD scope', async ({
    page,
}) => {
    const dialog = await openMethod(page, /Bulk import/i);

    // Bulk import reads everything from one file; no free-text field.
    await expect(
        dialog.getByRole('textbox', { name: 'Sources to import' })
    ).toHaveCount(0);
    await dialog.locator('input[type=file]').setInputFiles({
            name: 'sources.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
                JSON.stringify({
                    sources: [
                        {
                            type: 'm3u-url',
                            title: 'Bulk Live Only',
                            url: `${XTREAM_MOCK_SERVER}/bulk-one.m3u`,
                            importVod: false,
                        },
                        {
                            type: 'm3u-url',
                            title: 'Bulk Full',
                            url: `${XTREAM_MOCK_SERVER}/bulk-two.m3u`,
                        },
                    ],
                })
            ),
        });

    const rows = dialog.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(
        rows.first().getByRole('textbox', { name: 'Playlist title' })
    ).toHaveValue('Bulk Live Only');
    await expect(
        rows.nth(1).getByRole('textbox', { name: 'Playlist title' })
    ).toHaveValue('Bulk Full');
    await expect(
        rows.first().getByRole('checkbox', { name: 'Live channels' })
    ).toBeChecked();
    await expect(
        rows.first().getByRole('checkbox', { name: /VOD/ })
    ).not.toBeChecked();
    // The last checked box disables instead of clearing: unchecking it is
    // refused, so enable VOD first and then switch Live off for real.
    await expect(
        rows.first().getByRole('checkbox', { name: 'Live channels' })
    ).toBeDisabled();
    await rows.first().getByRole('checkbox', { name: /VOD/ }).click();
    await expect(
        rows.first().getByRole('checkbox', { name: 'Live channels' })
    ).toBeEnabled();
    await rows.first().getByRole('checkbox', { name: 'Live channels' }).click();
    await expect(
        rows.first().getByRole('checkbox', { name: 'Live channels' })
    ).not.toBeChecked();

    const add = dialog.getByRole('button', { name: 'Import 2 sources' });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(dialog).toBeHidden();
    await page.waitForURL(/playlists/);
});
