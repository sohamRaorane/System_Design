"""Generate otlp-trace.pb: a reference OTLP ExportTraceServiceRequest encoded by Google's
protobuf library (independent of the collector's hand-written decoder).

The message definitions mirror opentelemetry/proto v1 (trace.proto, common.proto,
resource.proto, trace_service.proto) field-for-field for the fields used here.

    pip install protobuf
    python make_otlp_fixture.py        # writes otlp-trace.pb next to this file
"""
import os

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

F = descriptor_pb2.FieldDescriptorProto
fdp = descriptor_pb2.FileDescriptorProto(name="otlp_subset.proto", package="otlp", syntax="proto3")


def msg(name, fields, enums=()):
    m = fdp.message_type.add(name=name)
    for fname, num, ftype, label, type_name in fields:
        f = m.field.add(name=fname, number=num, type=ftype, label=label)
        if type_name:
            f.type_name = type_name
    return m


OPT, REP = F.LABEL_OPTIONAL, F.LABEL_REPEATED
msg("AnyValue", [
    ("string_value", 1, F.TYPE_STRING, OPT, None),
    ("bool_value", 2, F.TYPE_BOOL, OPT, None),
    ("int_value", 3, F.TYPE_INT64, OPT, None),
    ("double_value", 4, F.TYPE_DOUBLE, OPT, None),
    ("array_value", 5, F.TYPE_MESSAGE, OPT, ".otlp.ArrayValue"),
    ("kvlist_value", 6, F.TYPE_MESSAGE, OPT, ".otlp.KeyValueList"),
    ("bytes_value", 7, F.TYPE_BYTES, OPT, None),
])
# AnyValue.value is a oneof in the real proto
any_msg = fdp.message_type[0]
any_msg.oneof_decl.add(name="value")
for f in any_msg.field:
    f.oneof_index = 0
msg("ArrayValue", [("values", 1, F.TYPE_MESSAGE, REP, ".otlp.AnyValue")])
msg("KeyValueList", [("values", 1, F.TYPE_MESSAGE, REP, ".otlp.KeyValue")])
msg("KeyValue", [("key", 1, F.TYPE_STRING, OPT, None), ("value", 2, F.TYPE_MESSAGE, OPT, ".otlp.AnyValue")])
msg("Resource", [("attributes", 1, F.TYPE_MESSAGE, REP, ".otlp.KeyValue"), ("dropped_attributes_count", 2, F.TYPE_UINT32, OPT, None)])
msg("InstrumentationScope", [("name", 1, F.TYPE_STRING, OPT, None), ("version", 2, F.TYPE_STRING, OPT, None)])
msg("Event", [
    ("time_unix_nano", 1, F.TYPE_FIXED64, OPT, None),
    ("name", 2, F.TYPE_STRING, OPT, None),
    ("attributes", 3, F.TYPE_MESSAGE, REP, ".otlp.KeyValue"),
    ("dropped_attributes_count", 4, F.TYPE_UINT32, OPT, None),
])
msg("Status", [("message", 2, F.TYPE_STRING, OPT, None), ("code", 3, F.TYPE_INT32, OPT, None)])
msg("Span", [
    ("trace_id", 1, F.TYPE_BYTES, OPT, None),
    ("span_id", 2, F.TYPE_BYTES, OPT, None),
    ("trace_state", 3, F.TYPE_STRING, OPT, None),
    ("parent_span_id", 4, F.TYPE_BYTES, OPT, None),
    ("name", 5, F.TYPE_STRING, OPT, None),
    ("kind", 6, F.TYPE_INT32, OPT, None),
    ("start_time_unix_nano", 7, F.TYPE_FIXED64, OPT, None),
    ("end_time_unix_nano", 8, F.TYPE_FIXED64, OPT, None),
    ("attributes", 9, F.TYPE_MESSAGE, REP, ".otlp.KeyValue"),
    ("dropped_attributes_count", 10, F.TYPE_UINT32, OPT, None),
    ("events", 11, F.TYPE_MESSAGE, REP, ".otlp.Event"),
    ("dropped_events_count", 12, F.TYPE_UINT32, OPT, None),
    ("dropped_links_count", 14, F.TYPE_UINT32, OPT, None),
    ("status", 15, F.TYPE_MESSAGE, OPT, ".otlp.Status"),
    ("flags", 16, F.TYPE_FIXED32, OPT, None),
])
msg("ScopeSpans", [
    ("scope", 1, F.TYPE_MESSAGE, OPT, ".otlp.InstrumentationScope"),
    ("spans", 2, F.TYPE_MESSAGE, REP, ".otlp.Span"),
    ("schema_url", 3, F.TYPE_STRING, OPT, None),
])
msg("ResourceSpans", [
    ("resource", 1, F.TYPE_MESSAGE, OPT, ".otlp.Resource"),
    ("scope_spans", 2, F.TYPE_MESSAGE, REP, ".otlp.ScopeSpans"),
    ("schema_url", 3, F.TYPE_STRING, OPT, None),
])
msg("ExportTraceServiceRequest", [("resource_spans", 1, F.TYPE_MESSAGE, REP, ".otlp.ResourceSpans")])

pool = descriptor_pool.DescriptorPool()
pool.Add(fdp)
M = {n: message_factory.GetMessageClass(pool.FindMessageTypeByName("otlp." + n)) for n in [
    "ExportTraceServiceRequest", "KeyValue", "AnyValue", "ArrayValue"]}


def kv(key, **v):
    out = M["KeyValue"](key=key)
    for k, val in v.items():
        if k == "array_value":
            out.value.array_value.values.extend(val)
        else:
            setattr(out.value, k, val)
    return out


req = M["ExportTraceServiceRequest"]()
rs = req.resource_spans.add()
rs.resource.attributes.extend([
    kv("service.name", string_value="Checkout"),
    kv("service.version", string_value="1.2.3"),
    kv("telemetry.sdk.language", string_value="nodejs"),
])
ss = rs.scope_spans.add()
ss.scope.name = "@opentelemetry/instrumentation-http"
ss.scope.version = "0.57.0"

TRACE = bytes.fromhex("5b8efff798038103d269b633813fc60c")
ROOT = bytes.fromhex("eee19b7ec3c1b174")
CHILD = bytes.fromhex("eee19b7ec3c1b173")
T0 = 1_800_000_000_123_456_789  # ns

root = ss.spans.add(trace_id=TRACE, span_id=ROOT, name="POST /checkout", kind=2,
                    start_time_unix_nano=T0, end_time_unix_nano=T0 + 250_400_000, flags=1)
root.attributes.extend([
    kv("http.request.method", string_value="POST"),
    kv("http.response.status_code", int_value=500),
    kv("server.address", string_value="shop.example.com"),
    kv("sampled.ratio", double_value=0.25),
    kv("retry", bool_value=True),
    kv("negative", int_value=-42),
    kv("tags", array_value=[M["AnyValue"](string_value="a"), M["AnyValue"](int_value=2)]),
])
root.status.code = 2
root.status.message = "upstream failed"

child = ss.spans.add(trace_id=TRACE, span_id=CHILD, parent_span_id=ROOT, name="charge card", kind=3,
                     start_time_unix_nano=T0 + 10_000_000, end_time_unix_nano=T0 + 10_000_000 + 999)
ev = child.events.add(time_unix_nano=T0 + 12_000_000, name="exception")
ev.attributes.extend([
    kv("exception.type", string_value="CardDeclined"),
    kv("exception.message", string_value="insufficient funds"),
])

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "otlp-trace.pb")
with open(out, "wb") as fh:
    fh.write(req.SerializeToString())
print("wrote", out, len(req.SerializeToString()), "bytes")
