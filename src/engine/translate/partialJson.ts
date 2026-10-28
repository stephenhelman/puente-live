const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };

/**
 * Pulls ONE string field out of a JSON object that arrives in fragments (the tool-use `input_json_delta` stream), so
 * the translation can be shown as it is generated. Feed each fragment to `push`; it returns the newly decoded characters
 * of the field's value. The authoritative value is always the JSON.parse of the complete input; this is only for display.
 */
export class JsonStringField {
  private head = "";
  private started = false;
  private finished = false;
  private carry = "";

  constructor(private readonly field: string) {}

  get done(): boolean {
    return this.finished;
  }

  push(fragment: string): string {
    if (this.finished) return "";
    let s = fragment;
    if (!this.started) {
      this.head += fragment;
      const m = new RegExp(`"${this.field}"\\s*:\\s*"`).exec(this.head);
      if (!m) return "";
      this.started = true;
      s = this.head.slice(m.index + m[0].length);
      this.head = "";
    }
    s = this.carry + s;
    this.carry = "";
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c === '"') {
        this.finished = true;
        break;
      }
      if (c !== "\\") {
        out += c;
        continue;
      }
      const n = s[i + 1];
      if (n === undefined) {
        this.carry = s.slice(i);
        break;
      }
      if (n === "u") {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) {
          this.carry = s.slice(i);
          break;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      out += SIMPLE_ESCAPES[n] ?? n;
      i++;
    }
    return out;
  }
}
