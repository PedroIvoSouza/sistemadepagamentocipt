<script>
  function setButtonLoading(btn, text){
    if (!btn || btn.dataset.loading === '1') return false;
    btn.dataset.loading = '1';
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy','true');
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${text}`;
    return true;
  }
  function unsetButtonLoading(btn){
    if (!btn) return;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    btn.dataset.loading = '';
  }
</script>
