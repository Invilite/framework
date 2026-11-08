/**
 * JSON safe for embedding inside `<script>` in a template. The `<` escape
 * prevents `</script>` breakout from user content.
 */
export class ScriptJson {

    public static serialize(value: unknown): string {
        return JSON.stringify(value).replace(/</g, '\\u003c');
    }
}