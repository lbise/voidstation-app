(() => {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url, location.href).pathname === "/api/metrics") {
      await new Promise((resolve) => window.setTimeout(resolve, 15_000));
    }
    return nativeFetch(...args);
  };
})();
