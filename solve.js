// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. Same broken-row policy, much faster.
//
// csv-reader walks the text one character at a time, building every field
// a character at a time. This reader instead jumps from delimiter to
// delimiter: an unquoted field is one slice up to the next comma or line
// break (found with indexOf), a quoted field one slice up to its closing
// quote (found with indexOf), and stray CRs are found from a list of
// their positions built once per case. The only character-at-a-time work
// left is inside quoted chunks that actually hold a line break, which is
// rare. Everything else about the policy is copied from the reference,
// field for field and error for error:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote; each CRLF or lone CR inside it
//     reads as LF; what follows the closing quote up to the next comma or
//     line break is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded with "" (short_row) or cut (long_row) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line the record starts on, row its index in rows (null for the header).
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const t = String(input.text);
  const header = input.header === true;
  const n = t.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && t.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, written by readUnquoted/readQuoted instead of returned,
  // so the hot path allocates no result object per field.
  let fieldValue = '';
  let fieldEnded = END;
  // Characters the last unquoted read appended (a quote_junk error needs it).
  let unquotedAdded = 0;

  // Where every CR in the text sits, in order. An unquoted read walks this
  // list with crIdx instead of scanning for CRs on every field.
  const crs = [];
  {
    let i = t.indexOf('\r');
    while (i !== -1) {
      crs.push(i);
      i = t.indexOf('\r', i + 1);
    }
  }
  let crIdx = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted chunk with line breaks in it, normalised the way the reference
  // reads them: every CRLF and every lone CR becomes one LF, and the line
  // count moves by one per break. Chunks without a break come back untouched.
  function normalise(chunk) {
    if (chunk.indexOf('\r') === -1 && chunk.indexOf('\n') === -1) return chunk;
    const breaks = chunk.match(/\r\n|\r|\n/g);
    if (breaks !== null) line += breaks.length;
    return chunk.replace(/\r\n?/g, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets fieldValue/fieldEnded.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      while (crIdx < crs.length && crs[crIdx] < pos) crIdx++;
      const ci = t.indexOf(',', pos);
      const ni = t.indexOf('\n', pos);
      let end;
      let isComma;
      if (ci === -1) {
        end = ni;
        isComma = false;
      } else if (ni === -1) {
        end = ci;
        isComma = true;
      } else if (ci < ni) {
        end = ci;
        isComma = true;
      } else {
        end = ni;
        isComma = false;
      }
      if (end === -1) end = n;
      // Any CR before the field's end: a CR right before a LF is that
      // line break's CRLF; any other is stray, dropped with an error.
      let cr = crIdx < crs.length ? crs[crIdx] : -1;
      while (cr !== -1 && cr < end) {
        if (t.charCodeAt(cr + 1) === 10) {
          if (cr > pos) {
            value += t.slice(pos, cr);
            added += cr - pos;
          }
          pos = cr + 2;
          line += 1;
          unquotedAdded = added;
          fieldValue = value;
          fieldEnded = LINE_BREAK;
          crIdx++;
          return;
        }
        if (cr > pos) {
          value += t.slice(pos, cr);
          added += cr - pos;
        }
        error('stray_cr');
        pos = cr + 1;
        crIdx++;
        cr = crIdx < crs.length ? crs[crIdx] : -1;
      }
      if (end > pos) {
        value += t.slice(pos, end);
        added += end - pos;
      }
      if (end >= n) {
        pos = n;
        unquotedAdded = added;
        fieldValue = value;
        fieldEnded = END;
        return;
      }
      if (isComma) {
        pos = end + 1;
        unquotedAdded = added;
        fieldValue = value;
        fieldEnded = COMMA;
        return;
      }
      pos = end + 1;
      line += 1;
      unquotedAdded = added;
      fieldValue = value;
      fieldEnded = LINE_BREAK;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fieldValue/fieldEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const j = t.indexOf('"', pos);
      if (j === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (t.charCodeAt(j + 1) === 34) {
        // A doubled quote is one literal quote.
        value += normalise(t.slice(pos, j)) + '"';
        pos = j + 2;
        continue;
      }
      value += normalise(t.slice(pos, j));
      pos = j + 1;
      if (pos >= n) {
        fieldValue = value;
        fieldEnded = END;
        return;
      }
      const c = t.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fieldValue = value;
        fieldEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && t.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fieldValue = value;
        fieldEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (unquotedAdded > 0) error('quote_junk');
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = t.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && t.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = t.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fieldValue);
    } while (fieldEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
