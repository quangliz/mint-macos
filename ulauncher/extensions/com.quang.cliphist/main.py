import json
import os
import time

from ulauncher.api.client.EventListener import EventListener
from ulauncher.api.client.Extension import Extension
from ulauncher.api.shared.action.CopyToClipboardAction import CopyToClipboardAction
from ulauncher.api.shared.action.DoNothingAction import DoNothingAction
from ulauncher.api.shared.action.RenderResultListAction import RenderResultListAction
from ulauncher.api.shared.event import KeywordQueryEvent
from ulauncher.api.shared.item.ExtensionResultItem import ExtensionResultItem

HISTORY = os.path.expanduser("~/.local/share/cliphist/history.json")
ICON = "images/icon.svg"
MAX_RESULTS = 12


def ago(ts):
    d = int(time.time() - ts)
    if d < 60:
        return "just now"
    if d < 3600:
        return f"{d // 60}m ago"
    if d < 86400:
        return f"{d // 3600}h ago"
    return f"{d // 86400}d ago"


class ClipHist(Extension):
    def __init__(self):
        super().__init__()
        self.subscribe(KeywordQueryEvent, QueryListener())


class QueryListener(EventListener):
    def on_event(self, event, extension):
        try:
            with open(HISTORY) as f:
                items = json.load(f)
        except (OSError, ValueError):
            items = []

        words = (event.get_argument() or "").lower().split()
        matches = [i for i in items if all(w in i["text"].lower() for w in words)]

        if not matches:
            msg = "No matching clips" if words else "Clipboard history is empty"
            return RenderResultListAction([ExtensionResultItem(
                icon=ICON, name=msg, description="Copy some text and it will show up here",
                on_enter=DoNothingAction())])

        results = []
        for item in matches[:MAX_RESULTS]:
            text = item["text"]
            first = " ".join(text.split())  # collapse newlines/whitespace for display
            name = first[:90] + ("…" if len(first) > 90 else "")
            lines = text.count("\n") + 1
            desc = f"{ago(item['time'])} · {len(text)} chars" + (f" · {lines} lines" if lines > 1 else "")
            results.append(ExtensionResultItem(icon=ICON, name=name, description=desc,
                                               on_enter=CopyToClipboardAction(text)))
        return RenderResultListAction(results)


if __name__ == "__main__":
    ClipHist().run()
