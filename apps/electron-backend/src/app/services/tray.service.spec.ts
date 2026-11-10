const mockExists = jest.fn();
const mockCreateFromPath = jest.fn();
const mockTrayInstance = {
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    on: jest.fn(),
};
const mockTrayCtor = jest.fn((..._args: unknown[]) => mockTrayInstance);

jest.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExists(...args),
}));

jest.mock('electron', () => ({
    app: {
        getAppPath: () => '/app',
        quit: jest.fn(),
    },
    nativeImage: {
        createFromPath: (...args: unknown[]) => mockCreateFromPath(...args),
    },
    Menu: {
        buildFromTemplate: () => ({}),
    },
    Tray: function Tray(...args: unknown[]) {
        return mockTrayCtor(...args);
    },
}));

type TrayService = typeof import('./tray.service');

async function loadService(): Promise<TrayService> {
    let service!: TrayService;
    await jest.isolateModulesAsync(async () => {
        service = await import('./tray.service');
    });
    return service;
}

describe('app tray', () => {
    beforeEach(() => {
        mockExists.mockReset().mockReturnValue(false);
        mockCreateFromPath.mockReset();
        mockTrayCtor.mockClear();
    });

    afterEach(() => {
        delete (process as unknown as { resourcesPath?: string }).resourcesPath;
    });

    it('loads the tray image the packaged build ships in resources', async () => {
        (process as unknown as { resourcesPath?: string }).resourcesPath = '/res';
        mockExists.mockImplementation(
            (candidate: string) => candidate === '/res/tray-icon.png'
        );
        mockCreateFromPath.mockReturnValue({ isEmpty: () => false });
        const { createAppTray } = await loadService();

        expect(createAppTray(jest.fn())).not.toBeNull();
        expect(mockCreateFromPath).toHaveBeenCalledWith('/res/tray-icon.png');
        expect(mockTrayCtor).toHaveBeenCalledTimes(1);
    });

    it('creates no tray while no icon file can be loaded', async () => {
        (process as unknown as { resourcesPath?: string }).resourcesPath = '/res';
        const { createAppTray } = await loadService();

        expect(createAppTray(jest.fn())).toBeNull();
        expect(mockTrayCtor).not.toHaveBeenCalled();
    });

    it('never asks nativeImage to read the executable', async () => {
        const { trayIconCandidates } = await loadService();

        expect(trayIconCandidates().some((path) => path.endsWith('.exe'))).toBe(
            false
        );
    });
});
