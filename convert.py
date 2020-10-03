import zipfile
import opencc
from pathlib import Path

# only initailize OpenCC once, or it would be very slow
converter = opencc.OpenCC(config="s2twp.json")

def convert_epub(epub, output=None):
    target_filetype = ["htm", "html", "xhtml", "ncx", "opf"]

    origin = zipfile.ZipFile(epub, mode="r")
    copy = zipfile.ZipFile(output, mode="w")

    for i, fn in enumerate(origin.namelist()):
        info = origin.getinfo(fn)
        extension = Path(fn).suffix[1:] # remove heading `.`
        if extension in target_filetype:
            # if file extension is targeted file type
            sc_content = origin.read(fn)
            tc_content = convert_content(sc_content)
            if extension == "opf":
                tc_content = tc_content.replace("<dc:language>zh-CN</dc:language>", "<dc:language>zh-TW</dc:language>")
            copy.writestr(s2t(fn), tc_content, compress_type=info.compress_type)
        else:
            # write other files directly
            copy.writestr(s2t(fn), origin.read(fn), compress_type=info.compress_type)

    origin.close()
    copy.close()
    return output

def convert_content(content):
    _tmp = []

    for line in content.splitlines():
        _tmp.append(s2t(line))

    return "\n".join(_tmp)

def s2t(text):
    return converter.convert(text)

if __name__ == "__main__":
    import argparse
    import glob
    import time
    from io import BytesIO

    parser = argparse.ArgumentParser(description="Convert simplified chinese to traditional chinese in epub.")
    parser.add_argument('file', nargs='+', help="epub files")
    args = parser.parse_args()

    if len(args.file) == 1 and "*" in args.file[0]:
        fn_list = glob.glob(args.file[0])
    else:
        fn_list = args.file

    for fn in fn_list:
        if not Path(fn).suffix == ".epub":
            print(f"Skipping file {fn}, which is not an epub document.")
        elif fn == s2t(fn):
            print(f"Skipping file {fn}, which has already been converted.")
        else:
            t = time.time()
            print(f"Converting {fn}")
            buffer = BytesIO()
            output = convert_epub(fn, buffer)
            with open(s2t(fn), "wb") as f:
                f.write(buffer.getvalue())
            print(f"File {fn} is successfully converted. Time elapsed: {round(time.time() - t, 2)}s")
