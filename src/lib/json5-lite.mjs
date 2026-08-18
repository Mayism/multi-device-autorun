// json5-lite.mjs
// 面向 AppScope/app.json5、build-profile.json5 等工程配置的宽松 JSON5 读取：
// 仅处理注释（// 与 /* */）、单双引号字符串、尾随逗号与裸标识符键，
// 不追求完整 JSON5 语法。全部在字符串状态跟踪下处理，避免误伤字符串内容。

function toJsonCompatible(text) {
  let out = "";
  let inString = false;
  let quote = "";
  let index = 0;
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[\w$]/.test(c);

  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];

    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (ch === quote) inString = false;
      index += 1;
      continue;
    }

    // 注释
    if (ch === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }

    // 字符串：统一输出为双引号（这些配置不含需要转义的单引号内容）
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += '"';
      index += 1;
      continue;
    }

    // 尾随逗号：向后看第一个非空白字符是否为 } 或 ]
    if (ch === ",") {
      let peek = index + 1;
      while (peek < text.length && /\s/.test(text[peek])) peek += 1;
      if (text[peek] === "}" || text[peek] === "]") {
        index += 1;
        continue;
      }
      out += ch;
      index += 1;
      continue;
    }

    // 裸标识符键：identifier 后（可有空白）紧跟冒号则加引号
    if (isIdentStart(ch)) {
      let end = index;
      while (end < text.length && isIdentPart(text[end])) end += 1;
      let peek = end;
      while (peek < text.length && /[ \t]/.test(text[peek])) peek += 1;
      const word = text.slice(index, end);
      if (text[peek] === ":" && !["true", "false", "null"].includes(word)) {
        out += `"${word}"`;
      } else {
        out += word;
      }
      index = end;
      continue;
    }

    out += ch;
    index += 1;
  }
  return out;
}

export function parseLooseJson5(text) {
  return JSON.parse(toJsonCompatible(String(text)));
}

export async function readLooseJson5(filePath) {
  const { readFile } = await import("node:fs/promises");
  return parseLooseJson5(await readFile(filePath, "utf8"));
}
