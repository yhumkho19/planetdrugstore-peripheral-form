package ph.planetdrugstore.schedule;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PushRegistrar {
    private static final String ENDPOINT = "https://peripherals-push.pds-peripherals.workers.dev/subscribe";
    private static final String APP_ORIGIN = "https://planetdrugstoreconsole.web.app";
    private static final String PREFS = "pds_alarm";
    private static final String STAFF_ID = "staff_id";
    private static final String HEAD_ROLE = "head_role";
    private static final ExecutorService NETWORK = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    public interface Callback {
        void complete(boolean success, String message);
    }

    private PushRegistrar() {}

    public static String savedStaffId(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(STAFF_ID, "");
    }

    public static String savedHeadRole(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(HEAD_ROLE, "");
    }

    public static void saveStaffId(Context context, String staffId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(STAFF_ID, staffId).remove(HEAD_ROLE).apply();
    }

    public static void saveHeadRole(Context context, String headRole) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(HEAD_ROLE, headRole).remove(STAFF_ID).apply();
    }

    public static void clearPairing(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(STAFF_ID).remove(HEAD_ROLE).apply();
    }

    public static void syncSaved(Context context, String token) {
        String staffId = savedStaffId(context);
        String headRole = savedHeadRole(context);
        if (!headRole.isEmpty()) request("POST", "", headRole, token, null);
        else if (!staffId.isEmpty()) request("POST", staffId, "", token, null);
    }

    public static void subscribe(Context context, String staffId, String token, Callback callback) {
        request("POST", staffId, "", token, callback);
    }

    public static void subscribeHead(Context context, String headRole, String token, Callback callback) {
        request("POST", "", headRole, token, callback);
    }

    public static void unsubscribe(Context context, String staffId, String headRole, String token, Callback callback) {
        request("DELETE", staffId, headRole, token, callback);
    }

    private static void request(String method, String staffId, String headRole, String token, Callback callback) {
        NETWORK.execute(() -> {
            HttpURLConnection connection = null;
            boolean success = false;
            String message = "Could not contact the notification service.";
            try {
                JSONObject body = new JSONObject();
                if (!staffId.isEmpty()) body.put("staffId", staffId);
                if (!headRole.isEmpty()) body.put("headRole", headRole);
                body.put("token", token);
                connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setRequestProperty("Origin", APP_ORIGIN);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int status = connection.getResponseCode();
                success = status >= 200 && status < 300;
                InputStream stream = success ? connection.getInputStream() : connection.getErrorStream();
                if (stream != null) {
                    try (Scanner scanner = new Scanner(stream, StandardCharsets.UTF_8.name()).useDelimiter("\\A")) {
                        if (scanner.hasNext()) message = scanner.next();
                    }
                }
                if (!success && message.isEmpty()) message = "Notification registration failed (" + status + ").";
            } catch (Exception error) {
                message = error.getMessage() == null ? message : error.getMessage();
            } finally {
                if (connection != null) connection.disconnect();
            }
            boolean result = success;
            String detail = message;
            if (callback != null) MAIN.post(() -> callback.complete(result, detail));
        });
    }
}