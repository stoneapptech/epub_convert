"""Independently verify the ZIP-level invariants of a generated EPUB."""

import argparse
import zipfile
from pathlib import Path


def verify_epub(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as archive:
        infos = archive.infolist()
        if not infos:
            raise ValueError("archive is empty")
        if infos[0].filename != "mimetype":
            raise ValueError("mimetype must be the first entry")
        if infos[0].compress_type != zipfile.ZIP_STORED:
            raise ValueError("mimetype must be stored without compression")
        if archive.read("mimetype") != b"application/epub+zip":
            raise ValueError("invalid EPUB mimetype content")
        if "META-INF/container.xml" not in archive.namelist():
            raise ValueError("missing META-INF/container.xml")

        bad_entry = archive.testzip()
        if bad_entry is not None:
            raise ValueError(f"CRC check failed for {bad_entry}")

    print(f"OK: {path} ({len(infos)} entries)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("epub", type=Path)
    args = parser.parse_args()
    verify_epub(args.epub)


if __name__ == "__main__":
    main()
