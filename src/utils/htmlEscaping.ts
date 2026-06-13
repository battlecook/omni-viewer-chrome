/**
 * Escape JSON strings so they can be safely embedded inside an HTML
 * `<script>` block without allowing the script to be terminated by an
 * attacker-controlled `</script>` (or HTML comment) sequence inside the
 * payload.
 *
 * The escaped output is still valid JSON: only HTML-significant characters
 * are converted to their `\uXXXX` Unicode escapes so they round-trip via
 * `JSON.parse`.
 */
export function escapeJsonForHtmlScriptTag(json: string): string {
    return json
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026');
}
