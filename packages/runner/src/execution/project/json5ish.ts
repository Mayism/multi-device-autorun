export function parseJson5ish(text: string): unknown {
  const withoutComments = removeComments(text);
  const withJsonStrings = normalizeSingleQuotedStrings(withoutComments);
  const withoutTrailingCommas = removeTrailingCommas(withJsonStrings);
  return JSON.parse(withoutTrailingCommas);
}

function removeComments(text: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        result += character;
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "\n" || character === "\r") {
        result += character;
      } else if (character === "*" && text[index + 1] === "/") {
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (quote !== undefined) {
      result += character;
      if (character === "\\" && index + 1 < text.length) {
        result += text[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      result += character;
      quote = character;
    } else if (character === "/" && text[index + 1] === "/") {
      index += 1;
      inLineComment = true;
    } else if (character === "/" && text[index + 1] === "*") {
      index += 1;
      inBlockComment = true;
    } else {
      result += character;
    }
  }

  return result;
}

function normalizeSingleQuotedStrings(text: string): string {
  let result = "";
  let quote: "single" | "double" | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quote === "double") {
      result += character;
      if (character === "\\" && index + 1 < text.length) {
        result += text[index + 1];
        index += 1;
      } else if (character === '"') {
        quote = undefined;
      }
      continue;
    }

    if (quote === "single") {
      if (character === "\\" && index + 1 < text.length) {
        const escaped = text[index + 1];
        result +=
          escaped === "'" ? "'" : escaped === '"' ? '\\"' : `\\${escaped}`;
        index += 1;
      } else if (character === "'") {
        result += '"';
        quote = undefined;
      } else {
        result += character === '"' ? '\\"' : character;
      }
      continue;
    }

    if (character === "'") {
      result += '"';
      quote = "single";
    } else {
      result += character;
      if (character === '"') {
        quote = "double";
      }
    }
  }

  return result;
}

function removeTrailingCommas(text: string): string {
  let result = "";
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      result += character;
      if (character === "\\" && index + 1 < text.length) {
        result += text[index + 1];
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      result += character;
      inString = true;
      continue;
    }

    if (character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(text[nextIndex] ?? "")) {
        nextIndex += 1;
      }
      if (text[nextIndex] === "}" || text[nextIndex] === "]") {
        continue;
      }
    }

    result += character;
  }

  return result;
}
