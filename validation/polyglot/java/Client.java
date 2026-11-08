import com.google.gson.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

// Gson tree API avoids unchecked casts. Both pipes drain concurrently.
public final class Client {
  static void require(boolean condition, String message) {
    if (!condition) throw new IllegalStateException(message);
  }
  public static void main(String[] args) throws Exception {
    JsonObject config = JsonParser.parseString(Files.readString(Path.of(args[0]))).getAsJsonObject();
    JsonArray records = new JsonArray();
    String handle = "";
    for (JsonElement item : config.getAsJsonArray("cases")) {
      JsonObject c = item.getAsJsonObject();
      List<String> command = new ArrayList<>();
      for (JsonElement word : config.getAsJsonArray("command")) command.add(word.getAsString());
      for (JsonElement word : c.getAsJsonArray("args")) command.add(word.getAsString().equals("$HANDLE") ? handle : word.getAsString());
      ProcessBuilder builder = new ProcessBuilder(command);
      builder.environment().clear();
      for (Map.Entry<String,JsonElement> entry : config.getAsJsonObject("environment").entrySet()) builder.environment().put(entry.getKey(), entry.getValue().getAsString());
      builder.environment().put("POLYGLOT_SCENARIO", c.get("scenario").getAsString());
      builder.environment().put("POLYGLOT_LOG", c.get("log").getAsString());
      Process process = builder.start();
      process.getOutputStream().close();
      ExecutorService readers = Executors.newFixedThreadPool(2);
      Future<String> stdout = readers.submit(() -> new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
      Future<String> stderr = readers.submit(() -> new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8));
      try {
        if (!process.waitFor(15, TimeUnit.SECONDS)) { process.destroyForcibly(); throw new IllegalStateException("CLI timed out"); }
        String out = stdout.get(5, TimeUnit.SECONDS);
        String err = stderr.get(5, TimeUnit.SECONDS);
        JsonObject envelope = JsonParser.parseString(out).getAsJsonObject();
        int code = process.exitValue();
        require(code == c.get("exitCode").getAsInt(), err + out);
        require(envelope.get("schemaVersion").getAsInt() == 1 && envelope.get("ok").getAsBoolean() == (code == 0), out);
        String expected = c.get("expected").getAsString();
        if (envelope.has("result")) {
          JsonObject result = envelope.getAsJsonObject("result");
          require(result.get("status").getAsString().equals(expected) && !envelope.has("error"), out);
          if (expected.equals("verified")) require(result.get("backend").getAsString().equals("sourcify") && result.get("match").getAsString().equals("exact"), out);
          if (expected.equals("failed")) require(result.get("reason").getAsString().contains("no_match"), out);
        } else {
          JsonObject error = envelope.getAsJsonObject("error");
          require(error.get("code").getAsString().equals(expected), out);
          if (expected.equals("not-confirmed")) {
            handle = error.get("handle").getAsString();
            require(error.get("retryable").getAsBoolean() && handle.startsWith("ev1:sourcify:11155111:"), out);
            JsonArray next = new JsonArray();
            for (String word : List.of("explorer-verify", "status", handle, "--json")) next.add(word);
            require(envelope.getAsJsonArray("nextCommand").equals(next), out);
          } else require(!error.get("retryable").getAsBoolean() && !error.get("hint").getAsString().isEmpty() && error.getAsJsonObject("details").get("code").getAsString().equals(expected), out);
        }
        JsonObject record = new JsonObject();
        record.add("name", c.get("name")); record.addProperty("success", true);
        record.addProperty("exitCode", code); record.add("envelope", envelope); record.addProperty("stderr", err);
        records.add(record);
      } finally { readers.shutdownNow(); if (process.isAlive()) process.destroyForcibly(); }
    }
    JsonObject output = new JsonObject(); output.addProperty("language", "java"); output.addProperty("success", true); output.add("scenarios", records);
    System.out.println(output);
  }
}
