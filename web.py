import tempfile
import hashlib
from io import BytesIO
from flask import (
    Flask, jsonify, request, render_template, send_file, url_for
)
from convert import convert_epub, s2t
from pathlib import Path

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

def human_file_size(bytes_count):
    threshold = 1024
    units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB']
    if bytes_count < threshold:
        return f"{bytes_count} B"

    ui = -1
    while True:
        bytes_count /= threshold
        ui += 1
        if bytes_count < threshold or ui == (len(units) - 1):
            break

    return f"{round(bytes_count, 1)} {units[ui]}"

@app.route("/", methods=["GET"])
def render_index():
    limit = app.config["MAX_CONTENT_LENGTH"]
    return render_template(
            "index.html.j2",
            limit=limit,
            limit_human_readable=human_file_size(limit),
            endpoint=url_for("upload_epub_sync")
        )

@app.route('/api/convert', methods=["POST"])
def upload_epub_sync():
    if 'upload' not in request.files:
        return jsonify({"status": False, "error": "No file is specified."}), 400

    epub_file = request.files['upload']

    if epub_file.filename == '':
        return jsonify({"status": False, "error": "No file name."}), 400

    # https://stackoverflow.com/questions/283707/size-of-an-open-file-object/283719#283719
    epub_file.seek(0, 2)
    end_position = epub_file.tell()
    if end_position > app.config['MAX_CONTENT_LENGTH']:
        return jsonify({"status": False, "error": f"File is too large. Maxium file size is {human_file_size(app.config['MAX_CONTENT_LENGTH'])}"}), 413

    if epub_file and Path(epub_file.filename).suffix == ".epub":
        output_buffer = BytesIO()
        try:
            _result = convert_epub(epub_file, output_buffer)
            print(f"Converted Successfully. File: {s2t(epub_file.filename)}")
            output_buffer.seek(0)
            return send_file(output_buffer, as_attachment=True, download_name=s2t(epub_file.filename))
        except Exception as e:
            error_class = e.__class__.__name__
            return jsonify({"status": False, "error": error_class}), 500
    else:
        return jsonify({"status": False, "error": "Not an epub document"}), 415 # Unsupported Media Type

if __name__ == "__main__":
    app.run(host="0.0.0.0")