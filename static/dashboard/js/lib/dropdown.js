// 通用自定义 dropdown 助手
// dd: { rootId, labelId, items: [{value, label}], initialValue, onChange }
import { escape } from "./escape.js";

export function setupDropdown({ rootId, labelId, items, initialValue, onChange }) {
  const root = document.getElementById(rootId);
  const toggle = root.querySelector(".dropdown-toggle");
  const menu = root.querySelector(".dropdown-menu");
  const labelEl = document.getElementById(labelId);

  const render = (selected) => {
    menu.innerHTML = items
      .map(
        (o) =>
          `<li data-value="${escape(o.value)}"${
            o.value === selected ? ' class="selected"' : ""
          }>${escape(o.label)}</li>`,
      )
      .join("");
    const cur = items.find((o) => o.value === selected) || items[0];
    if (cur) labelEl.textContent = cur.label;

    menu.querySelectorAll("li").forEach((li) => {
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = li.dataset.value;
        render(v);
        close();
        onChange(v);
      });
    });
  };

  const open = () => {
    root.classList.add("open");
    menu.hidden = false;
  };
  const close = () => {
    root.classList.remove("open");
    menu.hidden = true;
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    root.classList.contains("open") ? close() : open();
  });
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) close();
  });

  render(initialValue);
  return { setItems: (newItems, sel) => { items = newItems; render(sel); } };
}
