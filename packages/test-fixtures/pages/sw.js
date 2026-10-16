// Would answer every request itself if the runner let it register.
self.addEventListener("fetch", (event) => event.respondWith(new Response("from the service worker")));
