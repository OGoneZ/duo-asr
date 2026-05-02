// 自定义日历 popover：用于历史页 since/until 日期选择
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseIso(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function setupCalendarPopover({ onChange }) {
  let popover = null;
  let activeTrigger = null;
  let viewYear = 0;
  let viewMonth = 0;

  const close = () => {
    if (!popover) return;
    popover.remove();
    popover = null;
    if (activeTrigger) activeTrigger.classList.remove("is-open");
    activeTrigger = null;
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
  };

  const onDocClick = (e) => {
    if (popover && !popover.contains(e.target) && !e.target.closest(".date-trigger")) close();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  const render = () => {
    const first = new Date(viewYear, viewMonth, 1);
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prevDays = new Date(viewYear, viewMonth, 0).getDate();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayIso = fmtIso(today);
    const hidden = document.getElementById(activeTrigger.dataset.target);
    const selectedIso = hidden.value;

    const cells = [];
    for (let i = offset - 1; i >= 0; i--) {
      const d = prevDays - i;
      const iso = fmtIso(new Date(viewYear, viewMonth - 1, d));
      cells.push({ d, iso, otherMonth: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = fmtIso(new Date(viewYear, viewMonth, d));
      cells.push({ d, iso, otherMonth: false });
    }
    let nd = 1;
    while (cells.length < 42) {
      const iso = fmtIso(new Date(viewYear, viewMonth + 1, nd));
      cells.push({ d: nd++, iso, otherMonth: true });
    }

    popover.innerHTML = `
      <div class="cal-head">
        <button class="cal-nav cal-prev" type="button" aria-label="上一月">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="cal-title">${viewYear} 年 ${viewMonth + 1} 月</span>
        <button class="cal-nav cal-next" type="button" aria-label="下一月">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="cal-weekdays">
        ${WEEKDAYS.map((w) => `<span class="cal-weekday">${w}</span>`).join("")}
      </div>
      <div class="cal-grid">
        ${cells.map((c) => {
          const cls = ["cal-day"];
          if (c.otherMonth) cls.push("is-other-month");
          if (c.iso === todayIso) cls.push("is-today");
          if (c.iso === selectedIso) cls.push("is-selected");
          return `<button type="button" class="${cls.join(" ")}" data-iso="${c.iso}">${c.d}</button>`;
        }).join("")}
      </div>
      <div class="cal-foot">
        <button class="cal-action cal-today-btn" type="button" data-action="today">今天</button>
        <button class="cal-action" type="button" data-action="clear">清空</button>
      </div>
    `;

    popover.querySelector(".cal-prev").addEventListener("click", (e) => {
      e.stopPropagation();
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      render();
    });
    popover.querySelector(".cal-next").addEventListener("click", (e) => {
      e.stopPropagation();
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    });

    popover.querySelectorAll(".cal-day").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        hidden.value = btn.dataset.iso;
        onChange();
        close();
      });
    });

    popover.querySelectorAll(".cal-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (btn.dataset.action === "today") hidden.value = todayIso;
        else hidden.value = "";
        onChange();
        close();
      });
    });
  };

  const open = (trigger) => {
    if (activeTrigger === trigger) { close(); return; }
    close();
    activeTrigger = trigger;
    trigger.classList.add("is-open");

    const hidden = document.getElementById(trigger.dataset.target);
    const initial = parseIso(hidden.value) || new Date();
    viewYear = initial.getFullYear();
    viewMonth = initial.getMonth();

    popover = document.createElement("div");
    popover.className = "calendar-popover";
    const anchor = trigger.closest(".date-range");
    anchor.appendChild(popover);
    const triggerRect = trigger.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    popover.style.left = `${triggerRect.left - anchorRect.left}px`;

    render();
    setTimeout(() => {
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  };

  document.querySelectorAll(".date-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      open(trigger);
    });
  });

  return { close };
}
