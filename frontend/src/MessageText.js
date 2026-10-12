import { createElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components = {
  table: ({ children }) => createElement("div", { className: "message__table-scroll", tabIndex: 0,
    role: "region", "aria-label": "Tabella, scorrimento orizzontale" }, createElement("table", null, children)),
  a: ({ href, children }) => /^https?:\/\/|^mailto:|^#/.test(href || "") ?
    createElement("a", { href }, children) : createElement("span", null, children),
};

export function MessageText({ role, text }) {
  if (role === "user") return createElement("span", { className: "message__text" }, text);
  return createElement("div", { className: "message__text message__text--markdown" },
    createElement(Markdown, { skipHtml: true, disallowedElements: ["img"],
      remarkPlugins: [remarkGfm], components }, text));
}