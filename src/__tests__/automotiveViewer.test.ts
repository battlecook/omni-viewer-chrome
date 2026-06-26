import { mountAutomotiveViewer } from '../templates/automotive/js/automotiveViewerMain';
import { parseA2l, parseArxml, parseAsc, parseAvro, parseBag, parseBlf, parseDb3, parseMf4, parsePcap, parsePcapng, parseReqif, parseStp } from '../templates/automotive/js/automotiveParsers';
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

    it('loads and summarizes ReqIF through the shared table viewer', async () => {
        const file = new File([
            '<REQ-IF><THE-HEADER><REQ-IF-HEADER IDENTIFIER="h1">',
            '<TITLE>Demo requirements</TITLE><SOURCE-TOOL-ID>Tool</SOURCE-TOOL-ID>',
            '</REQ-IF-HEADER></THE-HEADER><CORE-CONTENT><REQ-IF-CONTENT>',
            '<SPEC-OBJECTS><SPEC-OBJECT IDENTIFIER="so1" LONG-NAME="Brake requirement"/></SPEC-OBJECTS>',
            '</REQ-IF-CONTENT></CORE-CONTENT></REQ-IF>'
        ], 'requirements.reqif', { type: 'application/xml' });
        const container = document.createElement('div');

        await mountAutomotiveViewer(file, container);

        expect(container.querySelector('.automotive-kind')?.textContent).toBe('REQIF');
        expect(container.textContent).toContain('Demo requirements');
        expect(container.textContent).toContain('1Spec objects');
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

    it('inspects Avro, ROS bag, STEP, DB3, and ReqIF files', () => {
        const avro = new Uint8Array([79, 98, 106, 1, 0]);
        expect(parseAvro(avro, '5 B').summary.find((item) => item.label === 'Magic')?.value).toBe('Obj\\x01');

        const bag = new Uint8Array(Array.from('#ROSBAG V2.0\nop=\x07op=\x05op=\x02', (char) => char.charCodeAt(0)));
        expect(parseBag(bag, '32 B').summary.find((item) => item.label === 'Connection records')?.value).toBe(1);

        const stp = parseStp("ISO-10303-21;\nHEADER;\nFILE_NAME('demo','2024',('me'),('org'),'pre','sys','auth');\nFILE_SCHEMA(('AP214'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;", '1 KB');
        expect(stp.summary.find((item) => item.label === 'Schema')?.value).toBe('AP214');
        expect(stp.tables[2].rows).toContainEqual(['#1', 'CARTESIAN_POINT', 7]);

        const db3 = new Uint8Array(128);
        db3.set(Array.from('SQLite format 3\0', (char) => char.charCodeAt(0)));
        new DataView(db3.buffer).setUint16(16, 4096, false);
        expect(parseDb3(db3, '128 B').summary.find((item) => item.label === 'Page size')?.value).toBe(4096);

        const reqif = parseReqif('<REQ-IF-HEADER IDENTIFIER="h"><TITLE>Spec</TITLE></REQ-IF-HEADER><SPECIFICATION IDENTIFIER="s1" LONG-NAME="System spec"/>', '1 KB');
        expect(reqif.summary.find((item) => item.label === 'Specifications')?.value).toBe(1);
    });

    it('decodes PCAP packet records and the PCAPNG section header', () => {
        const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
        const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
        const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
        const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

        // Ethernet + IPv4 + UDP + DNS query for example.com
        const dns = [...be16(0x1234), ...be16(0x0100), ...be16(1), ...be16(0), ...be16(0), ...be16(0), 7, ...str('example'), 3, ...str('com'), 0, ...be16(1), ...be16(1)];
        const udp = [...be16(40000), ...be16(53), ...be16(8 + dns.length), ...be16(0), ...dns];
        const ipv4 = [0x45, 0x00, ...be16(20 + udp.length), ...be16(0), ...be16(0), 64, 17, ...be16(0), 192, 168, 0, 10, 8, 8, 8, 8, ...udp];
        const eth = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, ...be16(0x0800), ...ipv4];
        const globalHeader = [0xd4, 0xc3, 0xb2, 0xa1, ...le16(2), ...le16(4), ...le32(0), ...le32(0), ...le32(65535), ...le32(1)];
        const record = [...le32(0), ...le32(0), ...le32(eth.length), ...le32(eth.length), ...eth];
        const pcap = new Uint8Array([...globalHeader, ...record]);

        const model = parsePcap(pcap, '1 KB');
        expect(model.summary.find((item) => item.label === 'Magic')?.value).toBe('0xA1B2C3D4');
        expect(model.summary.find((item) => item.label === 'Packets parsed')?.value).toBe(1);
        const packetRow = model.tables[1].rows[0];
        expect(packetRow[2]).toBe('DNS');
        expect(packetRow[3]).toBe('192.168.0.10:40000');
        expect(packetRow[4]).toBe('8.8.8.8:53');
        expect(String(packetRow[8])).toContain('example.com');

        // PCAPNG: single little-endian Section Header Block (28 bytes)
        const shb = [...le32(0x0a0d0d0a), ...le32(28), 0x4d, 0x3c, 0x2b, 0x1a, ...le16(1), ...le16(0), ...le32(0xffffffff), ...le32(0xffffffff), ...le32(28)];
        const ngModel = parsePcapng(new Uint8Array(shb), '28 B');
        expect(ngModel.summary.find((item) => item.label === 'Sections')?.value).toBe(1);
        expect(ngModel.summary.find((item) => item.label === 'Byte order')?.value).toBe('little endian');
    });
});
