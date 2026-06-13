// Password modal helper for the Chrome PDF viewer (issue #18).
//
// Wraps the show/hide DOM dance + submit/cancel callbacks so the main
// orchestrator stays lean. Used by `pdfViewerMain.ts` from inside the
// `onPassword` callback that pdf.js invokes for encrypted PDFs.

import { t } from '../../../utils/i18n';

export type PasswordReason = 'initial' | 'incorrect';

export interface PasswordModalDom {
    modal: HTMLElement;
    label: HTMLElement;
    hint: HTMLElement;
    input: HTMLInputElement;
    confirmBtn: HTMLButtonElement;
    cancelBtn: HTMLButtonElement;
}

export interface PasswordPromptHandle {
    show(reason: PasswordReason): void;
    hide(): void;
}

/**
 * Build the password prompt around an existing modal DOM. The caller
 * supplies `onSubmit` (gets the password) and `onCancel`. Returns a handle
 * the caller can use to re-show the modal on `incorrect-password` retries.
 */
export function attachPasswordPrompt(
    dom: PasswordModalDom,
    onSubmit: (password: string) => void,
    onCancel: () => void
): PasswordPromptHandle {
    let active = false;

    const show = (reason: PasswordReason): void => {
        active = true;
        const incorrect = reason === 'incorrect';
        dom.label.textContent = incorrect
            ? t('pdfPasswordPromptIncorrect', 'Incorrect password. Try again:')
            : t('pdfPasswordPromptInitial', 'Enter PDF password:');
        dom.hint.textContent = incorrect
            ? t('pdfPasswordHintIncorrect', 'The password did not match this PDF.')
            : t('pdfPasswordHintInitial', 'This PDF is password protected.');
        dom.hint.classList.toggle('is-error', incorrect);
        dom.hint.style.display = 'block';
        dom.input.value = '';
        dom.modal.style.display = 'flex';
        // Focus on next microtask so display:flex has paint-applied.
        Promise.resolve().then(() => {
            dom.input.focus();
            dom.input.select();
        });
    };

    const hide = (): void => {
        active = false;
        dom.modal.style.display = 'none';
        dom.input.value = '';
        dom.hint.style.display = 'none';
        dom.hint.classList.remove('is-error');
    };

    const submit = (): void => {
        if (!active) return;
        const value = dom.input.value;
        if (!value) {
            dom.hint.textContent = t('pdfPasswordEmpty', 'Please enter a password.');
            dom.hint.classList.add('is-error');
            dom.hint.style.display = 'block';
            dom.input.focus();
            return;
        }
        hide();
        onSubmit(value);
    };

    const cancel = (): void => {
        if (!active) return;
        hide();
        onCancel();
    };

    dom.confirmBtn.addEventListener('click', submit);
    dom.cancelBtn.addEventListener('click', cancel);
    dom.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    return { show, hide };
}

/**
 * pdf.js exposes a `PasswordResponses` enum:
 *   1 -> NEED_PASSWORD
 *   2 -> INCORRECT_PASSWORD
 * Translate to our `PasswordReason` so the prompt UI stays decoupled.
 */
export function reasonFromPdfJsResponse(code: number | undefined): PasswordReason {
    return code === 2 ? 'incorrect' : 'initial';
}

/**
 * True when an error from `getDocument(...)` is the pdf.js "load was
 * cancelled" path (typically because the user hit cancel on the password
 * modal). Mirrors the VSCode original's `isAbortedPdfLoad`.
 */
export function isAbortedPdfLoad(err: unknown): boolean {
    if (!err) return false;
    const message = (err as { message?: string }).message;
    if (!message) return false;
    return message === 'Loading aborted' || message === 'Worker was destroyed';
}
