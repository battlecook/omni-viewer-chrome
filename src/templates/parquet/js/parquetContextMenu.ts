// Cell-level right-click context menu for the Chrome Parquet viewer
// (issue #42). Pure helpers + a small DOM mount.

export interface ContextMenuItem {
    label: string;
    action: () => void;
}

export interface ClampPositionResult {
    left: number;
    top: number;
}

/**
 * Clamp a desired (x, y) so a menu of size (w, h) stays within the
 * viewport. Pure — used by `mountCellContextMenu` and tested directly.
 */
export function clampMenuPosition(opts: {
    desiredX: number;
    desiredY: number;
    menuWidth: number;
    menuHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    margin?: number;
}): ClampPositionResult {
    const margin = opts.margin ?? 4;
    const maxLeft = Math.max(margin, opts.viewportWidth - opts.menuWidth - margin);
    const maxTop = Math.max(margin, opts.viewportHeight - opts.menuHeight - margin);
    const left = Math.max(margin, Math.min(opts.desiredX, maxLeft));
    const top = Math.max(margin, Math.min(opts.desiredY, maxTop));
    return { left, top };
}

export type CellValue = unknown;
export type Row = CellValue[];

export function stringifyForCopy(value: CellValue): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, bigintReplacer);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export function copyCellValue(row: Row, colIdx: number): string {
    if (!Array.isArray(row) || colIdx < 0 || colIdx >= row.length) return '';
    return stringifyForCopy(row[colIdx]);
}

export function copyColumn(rows: Row[], colIdx: number): string {
    return rows.map((row) => copyCellValue(row, colIdx)).join('\n');
}

export function copyRowAsJson(row: Row, headers: string[]): string {
    const obj: Record<string, unknown> = {};
    const limit = Math.min(headers.length, row.length);
    for (let i = 0; i < limit; i++) {
        obj[headers[i] || `col${i}`] = serializeForJson(row[i]);
    }
    try {
        return JSON.stringify(obj, bigintReplacer, 2);
    } catch {
        return JSON.stringify({}, null, 2);
    }
}

function serializeForJson(value: CellValue): unknown {
    if (typeof value === 'bigint') return value.toString();
    return value;
}

function bigintReplacer(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
}

export interface CellLocation {
    rowIdx: number;
    colIdx: number;
}

export interface CellContextMenuOptions {
    table: HTMLTableElement;
    getVisibleRows: () => Row[];
    getHeaders: () => string[];
    getRowAt: (rowIdx: number) => Row | undefined;
    writeText: (text: string) => Promise<void> | void;
}

export interface CellContextMenuHandle {
    dispose(): void;
}

/**
 * Mount a delegated right-click handler on the parquet table that opens a
 * floating menu with cell / column / row copy actions. Returns a handle
 * with a `dispose` to detach all listeners + remove the menu node.
 */
export function mountCellContextMenu(opts: CellContextMenuOptions): CellContextMenuHandle {
    const menu = document.createElement('div');
    menu.className = 'pv-context-menu';
    menu.setAttribute('role', 'menu');
    menu.style.position = 'fixed';
    menu.style.display = 'none';
    document.body.appendChild(menu);

    const close = (): void => {
        menu.style.display = 'none';
    };

    const onContextMenu = (e: MouseEvent): void => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        const cell = target.closest<HTMLElement>('td');
        if (!cell || !opts.table.contains(cell)) return;
        const colAttr = cell.dataset.colIndex;
        const rowAttr = cell.parentElement instanceof HTMLElement
            ? cell.parentElement.dataset.rowIndex
            : undefined;
        if (colAttr === undefined || rowAttr === undefined) return;
        const colIdx = Number(colAttr);
        const rowIdx = Number(rowAttr);
        if (!Number.isInteger(colIdx) || !Number.isInteger(rowIdx)) return;

        e.preventDefault();
        const row = opts.getRowAt(rowIdx);
        if (!row) return;

        const headers = opts.getHeaders();
        const headerText = headers[colIdx] ?? `col${colIdx}`;
        const visibleRows = opts.getVisibleRows();

        menu.innerHTML = '';
        const items: ContextMenuItem[] = [
            {
                label: 'Copy cell value',
                action: () => void opts.writeText(copyCellValue(row, colIdx)),
            },
            {
                label: `Copy column "${headerText}"`,
                action: () => void opts.writeText(copyColumn(visibleRows, colIdx)),
            },
            {
                label: 'Copy row as JSON',
                action: () => void opts.writeText(copyRowAsJson(row, headers)),
            },
        ];

        for (const item of items) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pv-context-menu-item';
            btn.textContent = item.label;
            btn.addEventListener('click', () => {
                try {
                    item.action();
                } finally {
                    close();
                }
            });
            menu.appendChild(btn);
        }

        menu.style.display = 'block';
        const rect = menu.getBoundingClientRect();
        const pos = clampMenuPosition({
            desiredX: e.clientX,
            desiredY: e.clientY,
            menuWidth: rect.width || 180,
            menuHeight: rect.height || 100,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
        });
        menu.style.left = `${pos.left}px`;
        menu.style.top = `${pos.top}px`;
    };

    const onDocClick = (e: MouseEvent): void => {
        if (menu.style.display === 'none') return;
        if (e.target instanceof Node && menu.contains(e.target)) return;
        close();
    };

    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') close();
    };

    opts.table.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);

    return {
        dispose(): void {
            opts.table.removeEventListener('contextmenu', onContextMenu);
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
            try {
                menu.remove();
            } catch {
                // best-effort
            }
        },
    };
}
