"""camelCase ↔ snake_case payload serialization."""

from __future__ import annotations

import dataclasses
import functools
import re
import types
from typing import Any, Literal, TypeVar, Union, get_args, get_origin, get_type_hints

T = TypeVar("T")

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")


@functools.lru_cache(maxsize=512)
def camel_to_snake(name: str) -> str:
    """Convert a camelCase name to snake_case.

    @param name: The camelCase string to convert.
    @returns: The snake_case equivalent.
    """
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def snake_to_camel(name: str) -> str:
    """Convert a snake_case name to camelCase.

    @param name: The snake_case string to convert.
    @returns: The camelCase equivalent.
    """
    parts = name.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


def to_wire(payload: Any) -> dict[str, Any]:
    """Serialize a frozen dataclass to a camelCase wire dict.

    None values are omitted from the output to keep payloads minimal.

    @param payload: A frozen dataclass instance to serialize.
    @returns: A dict with camelCase keys, with None-valued fields excluded.
    """
    if not dataclasses.is_dataclass(payload):
        return _to_wire_value(payload)
    result: dict[str, Any] = {}
    for f in dataclasses.fields(payload):
        value = getattr(payload, f.name)
        if value is None:
            continue
        result[snake_to_camel(f.name)] = _to_wire_value(value)
    return result


@functools.lru_cache(maxsize=64)
def _field_names(cls: type) -> frozenset[str]:
    """Return the set of snake_case field names for *cls*.

    Cached so the dataclass field introspection only runs once per class.

    @param cls: A frozen dataclass type.
    @returns: Frozenset of field name strings.
    """
    return frozenset(f.name for f in dataclasses.fields(cls))  # type: ignore[arg-type]


def from_wire(data: dict[str, Any], cls: type[T]) -> T:
    """Deserialize a camelCase wire dict into a typed frozen dataclass.

    Unknown wire keys are silently ignored. Missing optional fields default
    to whatever the dataclass field default provides.

    @param data: A dict with camelCase keys from the wire protocol.
    @param cls: The frozen dataclass type to construct.
    @returns: An instance of ``cls`` populated from ``data``.
    """
    if not dataclasses.is_dataclass(cls):
        return data  # type: ignore[return-value]
    field_names = _field_names(cls)
    type_hints = get_type_hints(cls)
    kwargs: dict[str, Any] = {}
    for wire_key, value in data.items():
        snake_key = camel_to_snake(wire_key)
        if snake_key in field_names:
            kwargs[snake_key] = _from_wire_value(value, type_hints.get(snake_key))
    return cls(**kwargs)  # type: ignore[return-value]


def _to_wire_value(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return to_wire(value)
    if isinstance(value, list):
        return [_to_wire_value(item) for item in value]
    if isinstance(value, tuple):
        return [_to_wire_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_wire_value(item) for key, item in value.items()}
    return value


def _from_wire_value(value: Any, annotation: Any) -> Any:
    if annotation is None:
        return value

    origin = get_origin(annotation)
    args = get_args(annotation)

    if origin is types.UnionType or origin is Union:
        for arg in args:
            if arg is type(None):
                continue
            try:
                converted = _from_wire_value(value, arg)
            except TypeError:
                continue
            # Generated payload unions are dataclass variants. Primitive Literal
            # fields are validated inside from_wire(); identity preservation here
            # means this union arm did not materialize a variant instance.
            if converted is not value:
                return converted
        return value

    if origin is Literal:
        if value in args:
            return value
        raise TypeError(f"Expected one of {args!r}, got {value!r}")

    if origin is list and args and isinstance(value, list):
        return [_from_wire_value(item, args[0]) for item in value]

    if dataclasses.is_dataclass(annotation) and isinstance(value, dict):
        return from_wire(value, annotation)

    return value
