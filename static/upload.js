const CancelToken = axios.CancelToken;
let cancel;

/**
 * document query selector
 * @param {*} selector - select
 * @param {*} ctx - context
 * @returns {HTMLElement} ctx.querySelector(selector)
 */
const dqs = (selector, ctx = document) => {
    return ctx.querySelector(selector);
}

/**
 * alias for addEventListener
 * @param {*} event - event name
 * @param {*} callback - event callback
 * @returns {HTMLElement} this
 */
HTMLElement.prototype.on = function(event, callback) {
    this.addEventListener(event, callback);
    return this;
}

function updateFile(files, syncWithInput=true) {
    let filename = files[0].name;
    let size = files[0].size;

    // check file extension
    if (filename.split(".").pop() != "epub") {
        ts(".ts.snackbar").snackbar({
            content: "只接受 EPUB 格式的檔案!"
        });
        return false;
    }

    // check file size
    if (size >= sizeLimit) {
        ts(".ts.snackbar").snackbar({
            content: "檔案過大!"
        });
        return false;
    }

    // if this function is called due to <input>.onchange, then we should not set it again
    // or it would be cleared on firefox
    if (syncWithInput) {
        dqs("#upload").files = files;
    }

    dqs(".header", dqs("#dragzone")).textContent = filename;
    dqs(".description", dqs("#dragzone")).textContent = `檔案大小: ${humanFileSize(size, false)}`;
    dqs("#dragzone").dataset.mode = "selected";
}

/**
 * Reset info and `<input>`
 * @param {Event?} ev - If called by event listener, then it would clear its default behavior
 */
function reset(ev) {
    if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
    }
    dqs(".header", dqs("#dragzone")).textContent = "上傳";
    dqs(".description", dqs("#dragzone")).innerHTML = "將檔案拖拉至此處進行上傳，或是點擊此處選取檔案。<br>Max upload size : " + humanFileSize(sizeLimit, false);
    dqs("#dragzone").dataset.mode = "selecting";
    dqs("#upload").value = "";
}

// https://stackoverflow.com/a/14919494
function humanFileSize(bytes, si) {
    var thresh = si ? 1000 : 1024;
    if(Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }
    var units = si
        ? ['kB','MB','GB','TB','PB','EB','ZB','YB']
        : ['KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB'];
    var u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while (Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
}

dqs("#upload").on("change", ev => {
    let el = ev.target;
    if (el.files.length) {
        if (el.files.length > 1) {
            ts('.snackbar').snackbar({
                content: "一次僅可上傳一個檔案。"
            });
        } else {
            updateFile(el.files, false);
        }
    } else {
        reset();
    }
});

dqs(".ts.close.button").on("click", ev => {
    if (dqs("#dragzone").dataset.mode == "uploading") {
        if (cancel) {
            cancel();
        }
    }
    reset();
});

dqs("#submitbtn").on("click", ev => {
    ev.stopPropagation();
    ev.preventDefault();

    dqs("#dragzone").dataset.mode = "uploading";

    // clean up styles
    ["preparing", "positive", "negative"].forEach(c => {
        dqs("#progressbar").classList.toggle(c, false);
    });

    dqs("#progressbar .bar").style.width = "0";
    if (dqs("#downloadbtn").href) {
        window.URL.revokeObjectURL(dqs("#downloadbtn").href);
        dqs("#downloadbtn").href = "";
        dqs("#downloadbtn").removeAttribute("download");
    }

    axios.post("./api/convert", new FormData(document.form), {
        responseType: "blob",
        cancelToken: new CancelToken(function (executor) {
            cancel = executor;
        }),
        onUploadProgress: (ev) => {
            percentage = (ev.loaded / ev.total) * 100
            dqs("#progressbar .bar").style.width = percentage + "%";
            if (percentage == 100) {
                dqs("#progressbar").classList.add("preparing");
            }
        }
    }).then(function (res) {
        dqs("#dragzone").dataset.mode = "converted";
        dqs("#progressbar").classList.remove("preparing");

        let blob = new Blob([res.data], { type: "application/epub+zip" });
        let disposition = res.headers['content-disposition'];
        let filename = disposition.slice(disposition.lastIndexOf("=") + 1, disposition.length);
        if (filename.startsWith("UTF-8''")) {
            filename = decodeURIComponent(filename.slice(7, filename.length));
        }
        dqs("#downloadbtn").href = window.URL.createObjectURL(blob); 
        dqs("#downloadbtn").setAttribute("download", filename);
    }).catch(function (e) {
        dqs("#dragzone").dataset.mode = "uploadend";
        dqs("#progressbar").classList.remove("preparing");
        dqs("#progressbar").classList.add("negative");
        if (e.response) {
            if (e.response.data instanceof Blob && e.response.data.type == "application/json") {
                let reader = new FileReader();
                reader.onload = function () {
                    let data = JSON.parse(this.result);
                    ts(".snackbar").snackbar({
                        content: `錯誤: ${data.error}`
                    });
                }
                reader.readAsText(e.response.data);
            }
        } else if (axios.isCancel(e)) {
            console.log("Upload progress canceled");
            dqs("#progressbar").classList.remove("negative");
            ts(".snackbar").snackbar({
                content: "上傳已取消"
            });
            dqs("#dragzone").dataset.mode = "selecting";
        } else {
            console.error(e);
        }
    });
});

dqs("#dragzone").on("click", ev => {
    // if it is uploading, we dont have to deal with dragzone click
    if (dqs("#dragzone").dataset.mode != "uploading") {
        let allowlist = ["button", "a"];
        if (allowlist.indexOf(ev.target.tagName.toLowerCase()) == -1) {
            ev.preventDefault();
            dqs("#upload").click();
        }
    } else {
        ev.preventDefault();
    }
});

dqs("#dragzone").on("drop", ev => {
    ev.stopPropagation();
    ev.preventDefault();

    if (dqs("#dragzone").dataset.mode != "uploading") {
        let files = ev.dataTransfer.files;
        if (files) {
            if (files.length > 1) {
                ts('.snackbar').snackbar({
                    content: "一次僅可上傳一個檔案。"
                });
            } else if (files.length == 1) {
                updateFile(files);
            }
        }
    }
});

["dragenter", "dragover"].forEach(event => {
    dqs("#dragzone").on(event, ev => {
        ev.stopPropagation();
        ev.preventDefault();
    });
});