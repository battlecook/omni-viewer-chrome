import { mountAutomotiveViewer } from '../templates/automotive/js/automotiveViewerMain';
import { parseA2l, parseArxml, parseAsc, parseBlf, parseMf4 } from '../templates/automotive/js/automotiveParsers';
import { parseDbc } from '../templates/automotive/js/dbcParser';
import { AUTOMOTIVE_VIEWER_CSS } from '../templates/automotive/js/automotiveViewerStyles';

describe('automotive viewer', () => {
    it('loads and summarizes an A2L file', async () => {
        const file = new File([
            '/begin PROJECT Demo "Demo project"\n',
            '/begin MODULE ECU "Engine ECU"\n',
            '/begin MEASUREMENT EngineSpeed "RPM" UWORD NO_COMPU_METHOD 0 0 0 8000\n',
            '/end MEASUREMENT\n',
            '/begin CHARACTERISTIC Torque "Torque" VALUE 0x1000 UWORD 0 NO_COMPU_METHOD 0 1000\n',
            '/end CHARACTERISTIC\n',
            '/end MODULE\n',
            '/end PROJECT\n'
        ], 'calibration.a2l', { type: 'text/plain' });
        const container = document.createElement('div');

        const handle = await mountAutomotiveViewer(file, container);

        expect(container.querySelector('.automotive-kind')?.textContent).toBe('A2L');
        expect(container.textContent).toContain('EngineSpeed');
        expect(container.textContent).toContain('Torque');
        expect(container.textContent).toContain('1');

        handle.dispose();
        expect(container.innerHTML).toBe('');
    });

    it('gives tabular automotive viewers a full-width, usable workspace', () => {
        expect(AUTOMOTIVE_VIEWER_CSS).toContain('min-height: clamp(640px, 78vh, 980px)');
        expect(AUTOMOTIVE_VIEWER_CSS).toContain('min-height: 420px');
        expect(AUTOMOTIVE_VIEWER_CSS).toContain('body:has(.automotive-viewer-host) .app');
        expect(AUTOMOTIVE_VIEWER_CSS).toContain('.automotive-table-wrap th');
    });

    it('renders DBC messages, signals, filters, and value labels', async () => {
        const file = new File([[
            'VERSION "Demo DBC"', 'BU_: ECM BCM Tester', 'BO_ 256 EngineData: 8 ECM',
            ' SG_ EngineSpeed : 24|16@1+ (0.125,0) [0|8031.875] "rpm" BCM,Tester',
            ' SG_ EngineState : 8|8@1+ (1,0) [0|3] "" Tester',
            'CM_ BO_ 256 "Engine telemetry frame";', 'VAL_ 256 EngineState 0 "Off" 1 "Idle" 2 "Run";'
        ].join('\n')], 'network.dbc', { type: 'text/plain' });
        const container = document.createElement('div');
        await mountAutomotiveViewer(file, container);
        expect(container.textContent).toContain('EngineData');
        expect(container.textContent).toContain('EngineSpeed');
        container.querySelectorAll<HTMLTableRowElement>('.dbc-table-wrap tbody tr')[1].click();
        expect(container.textContent).toContain('0: Off');
        expect(container.textContent).toContain('2: Run');
    });
});

describe('automotive parsers', () => {
    it('matches the reference DBC model', () => {
        const model = parseDbc('BU_: ECM BCM\nBO_ 256 Frame: 8 ECM\n SG_ Speed : 0|16@1+ (0.1,0) [0|250] "km/h" BCM');
        expect(model.stats).toMatchObject({ messageCount: 1, signalCount: 1, nodeCount: 2, maxDlc: 8 });
        expect(model.messages[0].signals[0]).toMatchObject({ byteOrder: 'little_endian', factor: 0.1, unit: 'km/h' });
    });

    it('summarizes ARXML packages, elements, and references', () => {
        const model = parseArxml('<AUTOSAR xmlns="urn:test"><AR-PACKAGE><SHORT-NAME>Pkg</SHORT-NAME><FRAME><SHORT-NAME>FrameA</SHORT-NAME></FRAME><FRAME-REF DEST="FRAME">/FrameA</FRAME-REF></AR-PACKAGE></AUTOSAR>', '1 KB');
        expect(model.summary.find((item) => item.label === 'Packages')?.value).toBe(1);
        expect(model.tables[1].rows).toContainEqual(['FRAME', 'FrameA']);
        expect(model.tables[2].rows).toContainEqual(['FRAME-REF', 'FRAME', '/FrameA']);
    });

    it('summarizes A2L and parses classic/CAN FD ASC events', () => {
        const a2l = parseA2l('/begin PROJECT Demo ""\n/begin MODULE ECU ""\n/begin MEASUREMENT Speed ""\n/end MEASUREMENT', '1 KB');
        expect(a2l.summary.find((item) => item.label === 'Measurements')?.value).toBe(1);
        const asc = parseAsc('date today\n0.100 1 123 Rx d 2 AA BB\n30.300981 CANFD 3 Tx 50005x 0 1 5 0 140000 73 200050', '1 KB');
        expect(asc.summary.find((item) => item.label === 'Classic CAN events')?.value).toBe(1);
        expect(asc.summary.find((item) => item.label === 'CAN FD events')?.value).toBe(1);
    });

    it('inspects BLF and MF4 headers', () => {
        const blf = new Uint8Array(160); blf.set([76, 79, 71, 71]); const blfView = new DataView(blf.buffer); blfView.setUint32(4, 144, true); blfView.setUint32(32, 2, true); blfView.setBigUint64(128, BigInt(3), true);
        expect(parseBlf(blf, '160 B').summary.find((item) => item.label === 'Object count hint')?.value).toBe(3);
        const mf4 = new Uint8Array(Array.from('MDF     4.10    TEST    ##HD##DG##CG##CN', (char) => char.charCodeAt(0)));
        expect(parseMf4(mf4, '40 B').tables[0].rows).toEqual(expect.arrayContaining([['##HD', 1], ['##CN', 1]]));
    });
});
