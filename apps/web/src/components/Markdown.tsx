import { Fragment, type ReactNode } from "react";
import { highlight, resolveLanguage } from "./highlight";

// Builds React elements, never HTML, so model output has no injection surface.

/** A header row followed by a separator row; a lone pipe in prose is not a table. */
function isTableStart(line: string, next: string): boolean {
  return line.includes("|") && next.includes("-") && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(next);
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first, so `**` inside a code span stays literal.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("`")) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(token);
      const href = link?.[2] ?? "";
      // Only http(s) — a `javascript:` href from model output must never become a link.
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">{link?.[1]}</a>
        ) : (
          <Fragment key={key}>{link?.[1] ?? token}</Fragment>
        ),
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trimStart().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence
      const source = body.join("\n");
      const html = highlight(source, lang);
      blocks.push(
        <pre key={key++} className="code-block" data-lang={resolveLanguage(lang) ?? lang ?? undefined}>
          {html
            ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            : <code>{source}</code>}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]!.length;
      // Model output sits under the page's own h1-h3, so #..#### map to h4..h6.
      const Tag = depth === 1 ? "h4" : depth === 2 ? "h5" : "h6";
      blocks.push(
        <Tag key={key++} className={`md-h md-h${depth}`}>
          {inline(heading[2] ?? "", `h${key}`)}
        </Tag>,
      );
      i++;
      continue;
    }

    const nextLine = lines[i + 1] ?? "";
    if (isTableStart(line, nextLine)) {
      const cells = (row: string) =>
        row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const header = cells(line);
      const align = cells(nextLine).map((spec) =>
        spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : "left",
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      blocks.push(
        <div className="md-table-wrap" key={key++}>
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, n) => (
                  <th key={n} style={{ textAlign: align[n] ?? "left" }}>{inline(h, `th${key}-${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rn) => (
                <tr key={rn}>
                  {r.map((cell, cn) => (
                    <td key={cn} style={{ textAlign: align[cn] ?? "left" }}>
                      {inline(cell, `td${key}-${rn}-${cn}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">{inline(quoted.join(" "), `q${key}`)}</blockquote>,
      );
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key++} className="md-list">
          {items.map((it, n) => <li key={n}>{inline(it, `li${key}-${n}`)}</li>)}
        </Tag>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Every earlier branch has declined this line, so consume it before testing the next.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").trimStart().startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i] ?? "") &&
      !/^\s*>\s?/.test(lines[i] ?? "") &&
      !isTableStart(lines[i] ?? "", lines[i + 1] ?? "") &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push(<p key={key++} className="md-p">{inline(para.join(" "), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
