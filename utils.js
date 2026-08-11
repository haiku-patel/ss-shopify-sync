function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normaliseTags(tagsStr) {
  return (tagsStr || '').split(',').map(t => t.trim()).filter(Boolean).sort().join(',');
}

export { sleep, normaliseTags };
