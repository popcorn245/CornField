"""The API's entry point.

Example, not an import:
    import pantry_utils
"""
import json
from pantry_core.models import Item
from . import routes


def handle(body):
    item = Item(**json.loads(body))
    return routes.route(item)
