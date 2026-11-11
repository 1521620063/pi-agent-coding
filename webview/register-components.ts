import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/popup/popup.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/translations/zh-cn.js";
import { registerIconLibrary } from "@awesome.me/webawesome/dist/components/icon/library.js";
import { icons } from "@awesome.me/webawesome/dist/components/icon/library.system.js";

// The default resolver fetches SVGs, which the webview CSP forbids. Use the
// library's sprite/mutator hooks to render its bundled icons without a request.
const sources = { ...icons.regular, ...icons.solid };
const parsedIcons = new Map<string, Element>();
for (const library of ["system", "default"])
  registerIconLibrary(library, {
    resolver: (name) => `#pi-icon-${name}`,
    spriteSheet: true,
    mutator: (svg, host) => {
      const name = host?.name ?? "circle-question";
      let original = parsedIcons.get(name);
      if (!original) {
        original = new DOMParser().parseFromString(
          sources[name] ?? sources["circle-question"],
          "image/svg+xml",
        ).documentElement;
        parsedIcons.set(name, original);
      }
      svg.setAttribute("viewBox", original.getAttribute("viewBox")!);
      svg.setAttribute("fill", "currentColor");
      svg.replaceChildren(
        ...Array.from(original.childNodes, (node) => node.cloneNode(true)),
      );
    },
  });
