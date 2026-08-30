const { readFileSync } = require("node:fs");
const { compile } = require("@vue/compiler-dom");

const html = readFileSync("index.html", "utf8").replaceAll("\r\n", "\n");
const opening = '<div id="app" v-cloak>';
const start = html.indexOf(opening);
const bodyEnd = html.lastIndexOf("</body>");
const end = html.lastIndexOf("</div>", bodyEnd);

if (start < 0 || bodyEnd < 0 || end < start) {
    throw new Error("Could not isolate the #app template in index.html.");
}

compile(html.slice(start + opening.length, end), {
    onError(error) {
        throw error;
    },
});

console.log("Vue template compiled successfully.");
