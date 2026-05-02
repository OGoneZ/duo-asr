// 通用确认弹窗：替代 native confirm()
// 返回 Promise<boolean>，true 表示用户点了确认。
// danger=true 时确认按钮变红，焦点默认放到取消按钮（避免误触）。
export function customConfirm({
  title = "确认操作",
  message = "",
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("confirm-dialog");
    if (!dlg || typeof dlg.showModal !== "function") {
      resolve(window.confirm(message || title));
      return;
    }
    dlg.querySelector("#confirm-title").textContent = title;
    dlg.querySelector("#confirm-message").textContent = message;
    const ok = dlg.querySelector("#confirm-ok");
    const cancel = dlg.querySelector("#confirm-cancel");
    ok.textContent = confirmText;
    cancel.textContent = cancelText;
    ok.classList.toggle("is-danger", !!danger);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dlg.removeEventListener("click", onBackdrop);
      dlg.removeEventListener("close", onClose);
      try { dlg.close(); } catch {}
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    const onBackdrop = (e) => { if (e.target === dlg) finish(false); };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dlg.addEventListener("click", onBackdrop);
    dlg.addEventListener("close", onClose, { once: true });

    dlg.showModal();
    setTimeout(() => (danger ? cancel : ok).focus(), 30);
  });
}
