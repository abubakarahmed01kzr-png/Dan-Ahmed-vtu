const http = require("http");

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain"
    });

    res.end("Dan Ahmed VTU Server yana aiki!");
});

server.listen(3000, () => {
    console.log("Server yana aiki a port 3000");
});