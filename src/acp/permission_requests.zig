//! `session/request_permission` requests: the params every request shares,
//! and the forwarder that takes a subagent child's pending approval to the
//! client and gives the client's answer back to that child.

const std = @import("std");
const debug_trace = @import("../core/shared/debug_trace.zig");
const io_mod = @import("../core/shared/io.zig");
const jsonrpc = @import("jsonrpc.zig");
const server = @import("server.zig");
const subagent_approval_registry = @import("../core/subagent/approval_registry.zig");
const subagent_tool_host = @import("../core/subagent/tool_host.zig");
const tool_call_presentation = @import("tool_call_presentation.zig");
const types = @import("../core/shared/types.zig");

const Allocator = std.mem.Allocator;

/// How long the forwarder waits between checks for a child's next approval.
/// The parent's subagent wait polls children at the same pace.
const poll_interval_ms: i64 = 20;

/// Names the subagent child a request comes from, sent as
/// `_meta.fx.subagent` so the client can tell it from the parent's own.
pub const SubagentOrigin = struct {
    /// The child's session id. Child sessions are internal: the client
    /// answers on the parent's session.
    session_id: []const u8,
    work_id: []const u8,
    /// The child's own id for the call. `toolCall.toolCallId` adds the
    /// child's session id, so it cannot match one of the parent's calls.
    tool_call_id: []const u8,
};

pub const RequestParams = struct {
    session_id: []const u8,
    tool_call_id: []const u8,
    call: types.ToolCall,
    title: []const u8,
    subagent: ?SubagentOrigin = null,
};

pub fn writeParams(alloc: Allocator, writer: *std.Io.Writer, params: RequestParams) !void {
    var validated_arguments: std.Io.Writer.Allocating = .init(alloc);
    defer validated_arguments.deinit();
    try writeValidatedToolArguments(alloc, &validated_arguments.writer, params.call.arguments_json);

    try writer.writeAll("{\"sessionId\":");
    try jsonrpc.writeJsonStr(params.session_id, writer);
    try writer.writeAll(",\"toolCall\":{\"toolCallId\":");
    try jsonrpc.writeJsonStr(params.tool_call_id, writer);
    try writer.writeAll(",\"name\":");
    try jsonrpc.writeJsonStr(tool_call_presentation.acpToolName(params.call.name), writer);
    try writer.writeAll(",\"title\":");
    try jsonrpc.writeJsonStr(params.title, writer);
    try writer.writeAll(",\"kind\":");
    try jsonrpc.writeJsonStr(tool_call_presentation.mapToolKind(params.call.name).jsonString(), writer);
    try writer.writeAll(",\"status\":\"pending\",\"rawInput\":");
    try writer.writeAll(validated_arguments.written());
    try writer.writeAll("},\"options\":[");
    try writeOption(writer, "allow_once", "Allow once", "allow_once");
    try writer.writeByte(',');
    try writeOption(writer, "allow_always", "Allow for this session", "allow_always");
    try writer.writeByte(',');
    try writeOption(writer, "reject_once", "Reject", "reject_once");
    try writer.writeByte(']');
    if (params.subagent) |origin| {
        try writer.writeAll(",\"_meta\":{\"fx\":{\"subagent\":{\"sessionId\":");
        try jsonrpc.writeJsonStr(origin.session_id, writer);
        try writer.writeAll(",\"workId\":");
        try jsonrpc.writeJsonStr(origin.work_id, writer);
        try writer.writeAll(",\"toolCallId\":");
        try jsonrpc.writeJsonStr(origin.tool_call_id, writer);
        try writer.writeAll("}}}");
    }
    try writer.writeByte('}');
}

pub fn writeValidatedToolArguments(alloc: Allocator, writer: *std.Io.Writer, arguments_json: []const u8) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, alloc, arguments_json, .{}) catch
        return error.InvalidToolArgumentsJson;
    defer parsed.deinit();
    try std.json.Stringify.value(parsed.value, .{}, writer);
}

fn writeOption(
    writer: *std.Io.Writer,
    option_id: []const u8,
    name: []const u8,
    kind: []const u8,
) !void {
    try writer.writeAll("{\"optionId\":");
    try jsonrpc.writeJsonStr(option_id, writer);
    try writer.writeAll(",\"name\":");
    try jsonrpc.writeJsonStr(name, writer);
    try writer.writeAll(",\"kind\":");
    try jsonrpc.writeJsonStr(kind, writer);
    try writer.writeByte('}');
}

/// Forwards one child's approvals for as long as one of its turns runs.
/// The child's permission policy has already run when a request reaches the
/// approval registry: only requests a person would answer arrive here, and
/// the answer goes back through the registry like the terminal app's.
pub const ChildForwarder = struct {
    state: *server.ServerState,
    host: *subagent_tool_host.Runtime,
    /// The parent session the client knows; borrowed for the child's turn.
    session_id: []const u8,
    child_id: []const u8,
    mutex: std.Io.Mutex = .init,
    stopping: bool = false,
    /// The request the client holds now, cancelled when the turn ends.
    outbound_id: ?u64 = null,
    wake: std.Io.Event = .unset,
    thread: ?std.Thread = null,

    /// Starts forwarding. Without a thread the child's approvals stay
    /// unanswered, as before forwarding existed, so the failure is traced.
    pub fn start(self: *ChildForwarder) void {
        self.thread = std.Thread.spawn(.{}, run, .{self}) catch |err| {
            debug_trace.logf("subagent", "approval forwarding unavailable child_id={s} err={s}", .{ self.child_id, @errorName(err) });
            return;
        };
    }

    /// Ends forwarding when the child's turn ends. A request the client
    /// still holds is cancelled, and the child gets no answer from it.
    pub fn stop(self: *ChildForwarder) void {
        const thread = self.thread orelse return;
        self.mutex.lockUncancelable(io_mod.getIo());
        self.stopping = true;
        const outbound_id = self.outbound_id;
        self.mutex.unlock(io_mod.getIo());
        self.wake.set(io_mod.getIo());
        if (outbound_id) |id| server.cancelPermissionRequest(self.state, id);
        thread.join();
        self.thread = null;
    }

    fn stopRequested(self: *ChildForwarder) bool {
        self.mutex.lockUncancelable(io_mod.getIo());
        defer self.mutex.unlock(io_mod.getIo());
        return self.stopping;
    }

    fn run(self: *ChildForwarder) void {
        const alloc = self.state.alloc;
        while (!self.stopRequested()) {
            const loaded = self.host.pendingApprovalRequestForChild(alloc, self.child_id) catch |err| {
                debug_trace.logf("subagent", "approval forwarding stopped child_id={s} err={s}", .{ self.child_id, @errorName(err) });
                return;
            };
            if (loaded) |value| {
                var pending = value;
                defer pending.deinit(alloc);
                if (self.forward(alloc, &pending)) continue;
            }
            self.wake.waitTimeout(io_mod.getIo(), .{ .duration = .{
                .clock = .awake,
                .raw = .fromMilliseconds(poll_interval_ms),
            } }) catch {};
        }
    }

    /// Sends one request and resolves the child with the answer. Returns
    /// false when the request could not be sent and should be tried again.
    fn forward(
        self: *ChildForwarder,
        alloc: Allocator,
        pending: *const subagent_approval_registry.PendingRequest,
    ) bool {
        const request = pending.request.view();
        const call: types.ToolCall = if (pending.tool_call) |value|
            value.view()
        else
            .{ .id = pending.request_id, .name = "", .arguments_json = "{}" };
        const tool_call_id = alloc.print("{s}/{s}", .{ pending.child_id, call.id }) catch return false;
        defer alloc.free(tool_call_id);
        var params: std.Io.Writer.Allocating = .init(alloc);
        defer params.deinit();
        writeParams(alloc, &params.writer, .{
            .session_id = self.session_id,
            .tool_call_id = tool_call_id,
            .call = call,
            .title = request.label,
            .subagent = .{
                .session_id = pending.child_id,
                .work_id = pending.work_id,
                .tool_call_id = call.id,
            },
        }) catch |err| {
            // A request that cannot be described is denied, so the child
            // never waits on one the client cannot see.
            debug_trace.logf("subagent", "approval forwarding denied child_id={s} err={s}", .{ pending.child_id, @errorName(err) });
            self.resolve(pending, .deny);
            return true;
        };

        const id = blk: {
            self.mutex.lockUncancelable(io_mod.getIo());
            defer self.mutex.unlock(io_mod.getIo());
            if (self.stopping) return true;
            const id = server.beginPermissionRequest(self.state) orelse return false;
            // Written under the lock, so `stop` cancels only a request the
            // client has.
            self.state.writer.writeRequest(
                alloc,
                .{ .integer = @intCast(id) },
                "session/request_permission",
                params.written(),
            ) catch |err| {
                debug_trace.logf("subagent", "approval forwarding write failed child_id={s} err={s}", .{ pending.child_id, @errorName(err) });
                server.discardOutboundRequest(self.state, id);
                return false;
            };
            self.outbound_id = id;
            break :blk id;
        };
        debug_trace.logf("subagent", "approval forwarded child_id={s} request_id={s} acp_id={d}", .{ pending.child_id, pending.request_id, id });
        const decision = server.awaitPermissionDecision(self.state, id);
        self.mutex.lockUncancelable(io_mod.getIo());
        self.outbound_id = null;
        const stopping = self.stopping;
        self.mutex.unlock(io_mod.getIo());
        // The child's turn ended while the client held the request; the
        // child no longer waits for it.
        if (stopping) return true;
        self.resolve(pending, decision);
        return true;
    }

    fn resolve(
        self: *ChildForwarder,
        pending: *const subagent_approval_registry.PendingRequest,
        decision: types.ToolPermissionDecision,
    ) void {
        const result = self.host.resolveApproval(.{
            .request_id = pending.request_id,
            .child_id = pending.child_id,
            .decision = decision,
            .timestamp_ms = io_mod.milliTimestamp(),
        }) catch |err| {
            debug_trace.logf("subagent", "approval response failed child_id={s} request_id={s} err={s}", .{ pending.child_id, pending.request_id, @errorName(err) });
            return;
        };
        debug_trace.logf("subagent", "approval response {s} child_id={s} request_id={s} decision={s}", .{ @tagName(result), pending.child_id, pending.request_id, @tagName(decision) });
    }
};

test "a subagent request names the child and keeps the parent's session" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeParams(alloc, &out.writer, .{
        .session_id = "parent",
        .tool_call_id = "child/call_1",
        .call = .{ .id = "call_1", .name = "shell", .arguments_json = " {\"command\" : \"touch a\"} " },
        .title = "shell.run touch a",
        .subagent = .{ .session_id = "child", .work_id = "work", .tool_call_id = "call_1" },
    });
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.written(), .{});
    defer parsed.deinit();
    const root = parsed.value.object;
    try std.testing.expectEqualStrings("parent", root.get("sessionId").?.string);
    const tool_call = root.get("toolCall").?.object;
    try std.testing.expectEqualStrings("child/call_1", tool_call.get("toolCallId").?.string);
    try std.testing.expectEqualStrings("shell.run touch a", tool_call.get("title").?.string);
    try std.testing.expectEqualStrings("touch a", tool_call.get("rawInput").?.object.get("command").?.string);
    try std.testing.expectEqual(@as(usize, 3), root.get("options").?.array.items.len);
    const subagent = root.get("_meta").?.object.get("fx").?.object.get("subagent").?.object;
    try std.testing.expectEqualStrings("child", subagent.get("sessionId").?.string);
    try std.testing.expectEqualStrings("work", subagent.get("workId").?.string);
    try std.testing.expectEqualStrings("call_1", subagent.get("toolCallId").?.string);
}

test "a parent request carries no subagent metadata" {
    const alloc = std.testing.allocator;
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    try writeParams(alloc, &out.writer, .{
        .session_id = "parent",
        .tool_call_id = "call_1",
        .call = .{ .id = "call_1", .name = "read_file", .arguments_json = "{}" },
        .title = "read",
    });
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, out.written(), .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value.object.get("_meta") == null);
}
