#!/usr/bin/env python3
"""Clipboard history recorder for the Ulauncher "cb" extension.

Keeps the last MAX_ITEMS text clips in ~/.local/share/cliphist/history.json
(private to the user). Skips clips that password managers mark as secret.
"""
import json
import os
import time

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk

MAX_ITEMS = 100
MAX_CHARS = 20000
HISTORY = os.path.expanduser("~/.local/share/cliphist/history.json")
# Targets password managers set on copied secrets (KDE convention, used by KeePassXC, Bitwarden...)
SECRET_TARGETS = {"x-kde-passwordManagerHint"}


def load():
    try:
        with open(HISTORY) as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save(items):
    tmp = HISTORY + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, HISTORY)


class Recorder:
    def __init__(self):
        self.clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        self.clipboard.connect("owner-change", self.on_change)

    def on_change(self, clipboard, event):
        clipboard.request_targets(self.on_targets)

    def on_targets(self, clipboard, atoms, n_atoms=None):
        names = {a.name() for a in (atoms or [])}
        if names & SECRET_TARGETS:
            return
        clipboard.request_text(self.on_text)

    def on_text(self, clipboard, text):
        if not text or not text.strip():
            return
        text = text[:MAX_CHARS]
        items = [i for i in load() if i.get("text") != text]
        items.insert(0, {"text": text, "time": time.time()})
        save(items[:MAX_ITEMS])


if __name__ == "__main__":
    Recorder()
    GLib.MainLoop().run()
