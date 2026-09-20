// The theme has to be on <html> before the first paint, or a light-mode reload flashes the
// dark background for a frame. Dark is the brand's native surface, so it wins unless the user
// has deliberately picked light — the OS preference is not consulted. External rather than
// inline so the Content-Security-Policy can stay `script-src 'self'`: a classic script in the
// head is parser-blocking either way, so the paint still waits for it.
try {
  document.documentElement.dataset.theme = localStorage.getItem('nxd-theme') || 'dark'
} catch (e) {
  document.documentElement.dataset.theme = 'dark'
}