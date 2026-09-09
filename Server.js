const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const filePath = path.join(__dirname, "Index .html");

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Dan Ahmed VTU: An samu matsala wajen bude app.");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });

    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      app: "Dan Ahmed VTU"
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Page not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dan Ahmed VTU server yana aiki a port ${PORT}`);
});
