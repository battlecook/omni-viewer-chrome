// Layout tests for the PDF viewer sidebar (issue #86).
//
// The PDF viewer splits its body into a left thumbnail sidebar and a
// right document scroll port. These tests pin three contracts that
// must not regress:
//   1. The injected stylesheet defines the sidebar pane as a grid track
//      with its own `overflow-y: auto`, separate from the document pane.
//   2. The thumbnail click handler scrolls the document pane, NOT the
//      sidebar — i.e., clicking a thumbnail leaves `sidebar.scrollTop`
//      untouched.
//   3. The selected thumbnail receives the active-state class so the
//      sidebar reflects "current page" while the user reads.
//
// We test the stylesheet via the exported CSS string (string assertions
// — jsdom does not implement CSS grid sizing) and exercise the
// thumbnail behavior via the public `mountThumbnails(...)` helper.

import { PDF_VIEWER_CSS } from '../templates/pdf/js/pdfViewerStyles';
import { mountThumbnails } from '../templates/pdf/js/thumbnail';

describe('PDF sidebar layout — stylesheet contract', () => {
    it('renders .pv-body as a grid with two columns (sidebar + document)', () => {
        // The body must be a 2-track grid so the panes can each have an
        // independent scroll while the row shares the viewport height.
        expect(PDF_VIEWER_CSS).toMatch(/\.pv-body\s*{[^}]*display:\s*grid/);
        expect(PDF_VIEWER_CSS).toMatch(
            /\.pv-body\s*{[^}]*grid-template-columns:[^;]+/
        );
    });

    it('gives the thumbnail sidebar its own vertical scroll', () => {
        // `overflow-y: auto` on the sidebar is what keeps its scroll
        // position independent from the document scroll.
        expect(PDF_VIEWER_CSS).toMatch(
            /\.pv-thumbnail-sidebar\s*{[^}]*overflow-y:\s*auto/
        );
    });

    it('gives the document container its own scroll', () => {
        expect(PDF_VIEWER_CSS).toMatch(
            /\.pv-pdf-container\s*{[^}]*overflow:\s*auto/
        );
    });

    it('stacks panes vertically below the small-screen breakpoint', () => {
        // Drawer behaviour was scoped out per #86; the stacked fallback
        // keeps sidebar and body from overlapping on narrow viewports.
        expect(PDF_VIEWER_CSS).toMatch(/@media\s*\(\s*max-width:\s*720px\s*\)/);
    });
});

describe('PDF sidebar layout — thumbnail click scroll model', () => {
    /** Synthesize a minimal `PdfPageProxy` for the offscreen render path. */
    const makeFakePage = () => ({
        getViewport: ({ scale }: { scale: number }) => ({
            width: 90 * scale,
            height: 120 * scale
        }),
        render: () => ({
            promise: Promise.resolve(),
            cancel: () => undefined
        })
    });

    /** Build the DOM scaffolding the thumbnail helper expects. */
    const buildHost = (numPages: number): {
        sidebar: HTMLElement;
        scrollContainer: HTMLElement;
        pagesContainer: HTMLElement;
    } => {
        const sidebar = document.createElement('aside');
        sidebar.id = 'pv-thumbnailSidebar';
        sidebar.className = 'pv-thumbnail-sidebar';
        Object.defineProperty(sidebar, 'scrollTo', {
            value: jest.fn(({ top }: ScrollToOptions) => {
                sidebar.scrollTop = top ?? sidebar.scrollTop;
            }),
            configurable: true
        });
        document.body.appendChild(sidebar);

        const scrollContainer = document.createElement('section');
        Object.defineProperty(scrollContainer, 'scrollTop', {
            value: 0,
            writable: true,
            configurable: true
        });
        Object.defineProperty(scrollContainer, 'scrollTo', {
            value: jest.fn(({ top }: ScrollToOptions) => {
                scrollContainer.scrollTop = top ?? scrollContainer.scrollTop;
            }),
            configurable: true
        });
        document.body.appendChild(scrollContainer);

        const pagesContainer = document.createElement('div');
        pagesContainer.id = 'pv-pagesContainer';
        pagesContainer.className = 'pv-pages-container';
        for (let i = 1; i <= numPages; i++) {
            const w = document.createElement('div');
            w.className = 'pv-page-wrapper';
            w.dataset.pageNumber = String(i);
            pagesContainer.appendChild(w);
        }
        scrollContainer.appendChild(pagesContainer);
        return { sidebar, scrollContainer, pagesContainer };
    };

    // jsdom does not implement <canvas>.getContext('2d'); stub it so the
    // virtual thumbnail renderer's optional canvas path becomes a no-op
    // (the thumbnail helper already handles `null` from getContext).
    let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
    beforeEach(() => {
        originalGetContext = HTMLCanvasElement.prototype.getContext;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (HTMLCanvasElement.prototype as any).getContext = (): null => null;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        HTMLCanvasElement.prototype.getContext = originalGetContext;
    });

    it('scrolls the document page (not the sidebar) when a thumbnail is clicked', () => {
        const numPages = 5;
        const { sidebar, scrollContainer, pagesContainer } = buildHost(numPages);
        const handle = mountThumbnails({
            sidebar,
            scrollContainer,
            pagesContainer,
            numPages,
            getPage: () => makeFakePage(),
            slotHeight: 140
        });

        // Sanity: thumbnail items exist for the first slot.
        const firstThumb = sidebar.querySelector<HTMLElement>(
            '.pv-thumbnail-item[data-page-number="3"]'
        );
        expect(firstThumb).not.toBeNull();

        // Simulate the user scrolling the sidebar to a non-zero position
        // and clicking a thumbnail. The click handler must not change
        // `sidebar.scrollTop`; only the document pane's `scrollTo` should
        // be invoked.
        Object.defineProperty(sidebar, 'scrollTop', {
            value: 42,
            writable: true,
            configurable: true
        });
        const sidebarScrollTopBefore = sidebar.scrollTop;
        firstThumb!.click();

        expect(scrollContainer.scrollTo).toHaveBeenCalledWith({
            top: expect.any(Number),
            behavior: 'smooth'
        });
        // The sidebar's scroll position is untouched by the click.
        expect(sidebar.scrollTop).toBe(sidebarScrollTopBefore);

        handle.dispose();
    });

    it('marks the matching thumbnail active when setActivePage is called', () => {
        const numPages = 3;
        const { sidebar, scrollContainer, pagesContainer } = buildHost(numPages);
        const handle = mountThumbnails({
            sidebar,
            scrollContainer,
            pagesContainer,
            numPages,
            getPage: () => makeFakePage(),
            slotHeight: 140
        });

        handle.setActivePage(2);
        const active = sidebar.querySelectorAll('.is-active-thumb');
        expect(active.length).toBe(1);
        expect(
            (active[0] as HTMLElement).dataset.pageNumber
        ).toBe('2');

        // Switching active page moves the highlight; no leftover.
        handle.setActivePage(1);
        const nextActive = sidebar.querySelectorAll('.is-active-thumb');
        expect(nextActive.length).toBe(1);
        expect(
            (nextActive[0] as HTMLElement).dataset.pageNumber
        ).toBe('1');

        handle.dispose();
    });
});
