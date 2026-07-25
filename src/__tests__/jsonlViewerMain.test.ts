import { mountJsonlViewer } from '../templates/jsonl/js/jsonlViewerMain';

describe('JSONL editor / hover hand-off', () => {
    beforeEach(() => {
        document.body.replaceChildren();
        jest.useFakeTimers();
    });

    afterEach(() => jest.useRealTimers());

    it('opens valid JSON as pretty text and restores the hover preview after cancel', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        // jsdom's File implementation in this Jest setup does not implement
        // `text()`, while the viewer consumes only this File capability.
        const file = { name: 'rows.jsonl', text: async () => '{"name":"Gilbert","score":24}\n' } as File;
        const viewer = await mountJsonlViewer(file, host);
        const row = host.querySelector<HTMLElement>('.jl-row');
        expect(row).not.toBeNull();

        row!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 }));
        const popup = document.querySelector<HTMLElement>('.omni-jsonl-popup');
        const textarea = popup?.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.value).toBe('{\n  "name": "Gilbert",\n  "score": 24\n}');
        (popup?.querySelector<HTMLButtonElement>('.jl-edit-cancel'))?.click();

        expect(popup?.querySelector('pre')?.style.display).toBe('');
        row!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 40, clientY: 40 }));
        jest.advanceTimersByTime(150);
        expect(popup?.querySelector('pre')?.textContent).toContain('Gilbert');
        viewer.dispose();
    });

    it('serializes pretty editor JSON back to a single JSONL record on save', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const file = { name: 'rows.jsonl', text: async () => '{"score":24}\n' } as File;
        const viewer = await mountJsonlViewer(file, host);
        const row = host.querySelector<HTMLElement>('.jl-row')!;
        row.click();
        const popup = document.querySelector<HTMLElement>('.omni-jsonl-popup')!;
        const textarea = popup.querySelector<HTMLTextAreaElement>('textarea')!;
        textarea.value = '{\n  "score": 25\n}';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        popup.querySelector<HTMLButtonElement>('.jl-edit-save')!.click();
        expect(host.querySelector('.jl-line-content')?.textContent).toContain('{"score":25}');
        viewer.dispose();
    });
});
