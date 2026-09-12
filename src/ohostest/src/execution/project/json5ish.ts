export function parseJson5ish(text: string): unknown {
  const withoutComments = removeComments(text);
  const withJsonStrings = normalizeSingleQuotedStrings(withoutComments);
  const withQuotedKeys = quoteUnquotedKeys(withJsonStrings);
  const withoutTrailingCommas = removeTrailingCommas(withQuotedKeys);
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

function quoteUnquotedKeys(text: string): string {
  let result = "";
  let inString = false;
  let previousSignificant = "";
  const identifierPattern = /[A-Za-z0-9_$]/;

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
      previousSignificant = '"';
      continue;
    }

    if (/\s/.test(character)) {
      result += character;
      continue;
    }

    if (identifierPattern.test(character)) {
      let end = index;
      let identifier = "";
      while (end < text.length && identifierPattern.test(text[end]!)) {
        identifier += text[end];
        end += 1;
      }
      let after = end;
      while (after < text.length && /\s/.test(text[after]!)) {
        after += 1;
      }
      const inKeyPosition =
        (previousSignificant === "{" || previousSignificant === ",") &&
        text[after] === ":" &&
        identifier !== "true" &&
        identifier !== "false" &&
        identifier !== "null";
      result += inKeyPosition ? `"${identifier}"` : identifier;
      previousSignificant = identifier.at(-1) ?? "";
      index = end - 1;
      continue;
    }

    result += character;
    previousSignificant = character;
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
