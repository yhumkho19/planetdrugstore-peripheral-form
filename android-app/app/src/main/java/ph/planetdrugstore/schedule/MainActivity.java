package ph.planetdrugstore.schedule;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.ArrayAdapter;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends ComponentActivity {
    private static final String APP_ORIGIN = "https://planetdrugstoreconsole.web.app";
    private static final String CONSOLE_URL = APP_ORIGIN + "/dashboard?source=notifications-app";
    private static final String PUSH_WORKER_URL = "https://peripherals-push.pds-peripherals.workers.dev";
    private static final ExecutorService AUTH_NETWORK = Executors.newSingleThreadExecutor();
    private static final long TEST_ALARM_DURATION_MS = 60_000L;
    private static final int COLOR_BACKGROUND = Color.rgb(17, 18, 23);
    private static final int COLOR_SURFACE = Color.rgb(28, 31, 40);
    private static final int COLOR_SURFACE_RAISED = Color.rgb(38, 41, 52);
    private static final int COLOR_TEXT = Color.rgb(246, 247, 250);
    private static final int COLOR_MUTED = Color.rgb(159, 164, 177);
    private static final int COLOR_RED = Color.rgb(229, 70, 61);
    private static final int COLOR_RED_DARK = Color.rgb(67, 29, 29);
    private static final int COLOR_GREEN = Color.rgb(57, 204, 147);
    private static final int COLOR_GREEN_DARK = Color.rgb(17, 57, 40);
    private static final int COLOR_AMBER = Color.rgb(245, 184, 69);
    private static final int COLOR_AMBER_DARK = Color.rgb(66, 52, 27);
    private static final int COLOR_BORDER = Color.rgb(53, 57, 69);
    private static final String[] ACCOUNT_TYPES = {
        "Employee", "Operations head", "Billing head", "Information head",
        "Stock Request Meds Admin", "Stock Request Supplies Admin"
    };
    private static final String[] HEAD_ROLES = {"", "pharmacist", "billing", "information", "stock", "stock"};
    private static final String[] HEAD_EMAILS = {
        "", "pharmacistdepart@planetdrugstore.ph", "billingdepart@planetdrugstore.ph",
        "informationdepart@planetdrugstore.ph", "adminstockreqmeds@planetdrugstore.ph",
        "adminstockreqsup@planetdrugstore.ph"
    };
    private Spinner accountTypeInput;
    private EditText staffIdInput;
    private EditText passwordInput;
    private TextView statusText;
    private Button connectButton;
    private TextView connectionStatusIcon;
    private ProgressBar connectionStatusSpinner;
    private ObjectAnimator logoAnimator;
    private String statusMessage = "";
    private boolean statusIsError;
    private boolean refreshingConnection;
    private boolean showingTestAlarm;
    private long testAlarmStartedAt;
    private final Handler alarmUiHandler = new Handler(Looper.getMainLooper());
    private final Runnable finishTestAlarm = () -> {
        if (!showingTestAlarm) return;
        stopService(new Intent(this, AlarmPlaybackService.class));
        showingTestAlarm = false;
        testAlarmStartedAt = 0L;
        buildScreen();
    };

    private final ActivityResultLauncher<String> notificationPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) {
                    String staffId = PushRegistrar.savedStaffId(this);
                    String headRole = PushRegistrar.savedHeadRole(this);
                    if (FirebaseAuth.getInstance().getCurrentUser() != null
                            && (!staffId.isEmpty() || !headRole.isEmpty())) {
                        refreshConnection(staffId, headRole);
                    } else {
                        authenticateAndConnect();
                    }
                }
                else setStatus("Allow notifications to receive background schedule alarms.", true);
            });

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FirebaseApp.initializeApp(this);
        NotificationChannels.create(this);
        if (state != null) {
            showingTestAlarm = state.getBoolean("showingTestAlarm", false);
            testAlarmStartedAt = state.getLong("testAlarmStartedAt", 0L);
        }
        buildScreen();
        if (showingTestAlarm) scheduleTestAlarmEnd();
    }

    private void buildScreen() {
        if (logoAnimator != null) logoAnimator.cancel();
        connectionStatusIcon = null;
        connectionStatusSpinner = null;
        getWindow().setStatusBarColor(COLOR_BACKGROUND);
        getWindow().setNavigationBarColor(COLOR_BACKGROUND);
        if (showingTestAlarm) {
            buildTestAlarmScreen();
            return;
        }

        String savedId = PushRegistrar.savedStaffId(this);
        String savedHeadRole = PushRegistrar.savedHeadRole(this);
        boolean hasSavedPairing = !savedId.isEmpty() || !savedHeadRole.isEmpty();
        boolean hasNativeAccount = FirebaseAuth.getInstance().getCurrentUser() != null;
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(COLOR_BACKGROUND);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(20), dp(20), dp(28));
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        addBrandHeader(content);

        if (hasSavedPairing && hasNativeAccount) {
            buildConnectedScreen(content, savedId, savedHeadRole);
        } else {
            buildLoginScreen(content, hasSavedPairing);
        }

        statusText = text(statusMessage, 13, statusIsError ? COLOR_RED : COLOR_MUTED, false);
        statusText.setGravity(Gravity.CENTER);
        content.addView(statusText, matchWrap(dp(16)));
        Button openConsole = outlineButton("Open console  ↗");
        content.addView(openConsole, matchWrap(0));
        openConsole.setOnClickListener(view -> openConsole());
        setContentView(scroll);
    }

    private void addBrandHeader(LinearLayout content) {
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.pds_launcher);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        header.addView(logo, new LinearLayout.LayoutParams(dp(46), dp(46)));

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        brand.setPadding(dp(12), 0, 0, 0);
        TextView name = text("Planet Drugstore", 17, COLOR_TEXT, true);
        brand.addView(name, matchWrap(dp(2)));
        brand.addView(text("Notification center", 13, COLOR_MUTED, false), matchWrap(0));
        header.addView(brand, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        content.addView(header, matchWrap(dp(28)));

        logoAnimator = ObjectAnimator.ofFloat(logo, "translationY", 0f, -dp(3));
        logoAnimator.setDuration(1800);
        logoAnimator.setRepeatMode(ValueAnimator.REVERSE);
        logoAnimator.setRepeatCount(ValueAnimator.INFINITE);
        logoAnimator.start();
    }

    private void buildConnectedScreen(LinearLayout content, String savedId, String savedHeadRole) {
        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.setPadding(dp(8), dp(8), dp(8), dp(10));

        hero.addView(createConnectionStatusCircle(true),
                new LinearLayout.LayoutParams(dp(106), dp(106)));
        TextView title = text("You’re connected", 28, COLOR_TEXT, true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = matchWrap(dp(8));
        titleParams.topMargin = dp(24);
        hero.addView(title, titleParams);
        TextView subtitle = text(
                "Updates from Planet Drugstore apps will reach this phone, even when the app is in the background.",
                15, COLOR_MUTED, false);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setLineSpacing(dp(3), 1f);
        hero.addView(subtitle, matchWrap(dp(18)));

        String identity = !savedHeadRole.isEmpty()
                ? accountTypeForRole(savedHeadRole)
                : savedId;
        TextView connectedAs = text("Connected as  " + identity, 13, COLOR_GREEN, true);
        connectedAs.setGravity(Gravity.CENTER);
        connectedAs.setPadding(dp(16), dp(9), dp(16), dp(9));
        connectedAs.setBackground(roundedBackground(COLOR_GREEN_DARK, 24, Color.TRANSPARENT, 0));
        hero.addView(connectedAs, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        content.addView(hero, matchWrap(dp(18)));

        connectButton = button("Refresh connection");
        content.addView(connectButton, matchWrap(dp(10)));
        connectButton.setOnClickListener(view -> requestPermissionOrConnect(false));

        Button disconnect = outlineButton("Disconnect this device");
        content.addView(disconnect, matchWrap(dp(22)));
        disconnect.setOnClickListener(view -> confirmDisconnectDevice(savedId, savedHeadRole));

        LinearLayout settingsCard = card();
        boolean notificationsAllowed = areNotificationsAllowed();
        settingsCard.addView(preferenceRow(
                "🔒",
                "Lock screen alerts",
                "Turn on notifications for this app in Android settings.",
                notificationsAllowed ? "Allowed" : "Blocked",
                notificationsAllowed ? COLOR_GREEN : COLOR_AMBER,
                notificationsAllowed ? COLOR_GREEN_DARK : COLOR_AMBER_DARK,
                view -> openNotificationSettings()));
        View divider = new View(this);
        divider.setBackgroundColor(COLOR_BORDER);
        settingsCard.addView(divider, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        LinearLayout eventAlarmRow = preferenceRow(
                "🔔",
                "Event alarms",
                "Ring for up to 60 seconds until you respond.",
                "", COLOR_TEXT, COLOR_SURFACE_RAISED, null);
        Button testAlarm = outlineButton("Test");
        testAlarm.setTextColor(COLOR_RED);
        eventAlarmRow.addView(testAlarm, new LinearLayout.LayoutParams(dp(82), dp(54)));
        testAlarm.setOnClickListener(view -> startTestAlarm());
        settingsCard.addView(eventAlarmRow);
        content.addView(settingsCard, matchWrap(dp(24)));
    }

    private void buildLoginScreen(LinearLayout content, boolean hasSavedPairing) {
        if (hasSavedPairing) {
            statusMessage = "Sign in once after this app update to keep console access connected.";
            statusIsError = false;
        }

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER);
        hero.addView(createConnectionStatusCircle(false),
                new LinearLayout.LayoutParams(dp(92), dp(92)));
        TextView title = text(hasSavedPairing ? "Reconnect your account" : "You’re not connected",
                27, COLOR_TEXT, true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = matchWrap(dp(8));
        titleParams.topMargin = dp(20);
        hero.addView(title, titleParams);
        TextView intro = text(
                "Connect your account to receive updates and event alarms, even when this app is in the background.",
                15, COLOR_MUTED, false);
        intro.setGravity(Gravity.CENTER);
        intro.setLineSpacing(dp(3), 1f);
        hero.addView(intro, matchWrap(dp(22)));
        content.addView(hero, matchWrap(dp(4)));

        LinearLayout loginCard = card();
        TextView accountLabel = text("CONNECT YOUR ACCOUNT", 12, COLOR_MUTED, true);
        loginCard.addView(accountLabel, matchWrap(dp(8)));
        accountTypeInput = new Spinner(this);
        ArrayAdapter<String> accountTypes = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_dropdown_item, ACCOUNT_TYPES);
        accountTypes.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        accountTypeInput.setAdapter(accountTypes);
        accountTypeInput.setPopupBackgroundDrawable(roundedBackground(COLOR_SURFACE_RAISED, 12, COLOR_BORDER, dp(1)));
        accountTypeInput.setBackground(roundedBackground(COLOR_SURFACE_RAISED, 12, COLOR_BORDER, dp(1)));
        loginCard.addView(accountTypeInput, matchWrap(dp(10)));
        staffIdInput = input("Staff ID", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        loginCard.addView(staffIdInput, matchWrap(dp(10)));
        accountTypeInput.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            private int previousPosition = -1;

            @Override
            public void onItemSelected(AdapterView<?> parent, android.view.View view, int position, long id) {
                boolean isEmployee = position == 0;
                staffIdInput.setHint(isEmployee ? "Staff ID" : "Department email");
                staffIdInput.setInputType(isEmployee
                        ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                        : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
                if (position == 4 || position == 5) {
                    staffIdInput.setText(HEAD_EMAILS[position]);
                } else if (previousPosition == 4 || previousPosition == 5) {
                    staffIdInput.setText("");
                }
                if (passwordInput != null) {
                    passwordInput.setHint(isEmployee ? "Employee password" : "Department password");
                }
                previousPosition = position;
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        passwordInput = input("Employee password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        loginCard.addView(passwordInput, matchWrap(dp(16)));
        connectButton = button("Enable notifications");
        loginCard.addView(connectButton, matchWrap(0));
        connectButton.setOnClickListener(view -> requestPermissionOrConnect(true));
        content.addView(loginCard, matchWrap(dp(20)));

        TextView note = text(
                "Allow notifications to receive alerts on your lock screen. Event alarms can ring for up to 60 seconds.",
                13, COLOR_MUTED, false);
        note.setGravity(Gravity.CENTER);
        note.setLineSpacing(dp(3), 1f);
        content.addView(note, matchWrap(dp(8)));
    }

    private FrameLayout createConnectionStatusCircle(boolean connected) {
        FrameLayout circle = new FrameLayout(this);
        circle.setBackground(roundedBackground(
                connected ? COLOR_GREEN_DARK : COLOR_RED_DARK,
                100,
                connected ? COLOR_GREEN : COLOR_RED,
                dp(2)));

        connectionStatusIcon = text(connected ? "✓" : "×", 50,
                connected ? COLOR_GREEN : COLOR_RED, true);
        connectionStatusIcon.setGravity(Gravity.CENTER);
        circle.addView(connectionStatusIcon, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        connectionStatusSpinner = new ProgressBar(
                this, null, android.R.attr.progressBarStyleSmall);
        connectionStatusSpinner.setIndeterminate(true);
        connectionStatusSpinner.setIndeterminateTintList(
                android.content.res.ColorStateList.valueOf(connected ? COLOR_GREEN : COLOR_RED));
        connectionStatusSpinner.setVisibility(refreshingConnection ? View.VISIBLE : View.GONE);
        connectionStatusIcon.setVisibility(refreshingConnection ? View.GONE : View.VISIBLE);
        circle.addView(connectionStatusSpinner, new FrameLayout.LayoutParams(
                dp(58), dp(58), Gravity.CENTER));
        return circle;
    }

    private void setConnectionRefreshing(boolean refreshing) {
        refreshingConnection = refreshing;
        if (connectionStatusIcon != null) {
            connectionStatusIcon.setVisibility(refreshing ? View.GONE : View.VISIBLE);
        }
        if (connectionStatusSpinner != null) {
            connectionStatusSpinner.setVisibility(refreshing ? View.VISIBLE : View.GONE);
        }
    }

    private LinearLayout preferenceRow(String icon, String title, String subtitle, String status,
                                       int statusColor, int statusBackground, View.OnClickListener onClick) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(12), 0, dp(12));

        TextView iconView = text(icon, 21, COLOR_RED, true);
        iconView.setGravity(Gravity.CENTER);
        iconView.setBackground(roundedBackground(COLOR_RED_DARK, 14, Color.TRANSPARENT, 0));
        row.addView(iconView, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout labels = new LinearLayout(this);
        labels.setOrientation(LinearLayout.VERTICAL);
        labels.setPadding(dp(12), 0, dp(8), 0);
        TextView heading = text(title, 15, COLOR_TEXT, true);
        labels.addView(heading, matchWrap(dp(3)));
        TextView description = text(subtitle, 12, COLOR_MUTED, false);
        description.setLineSpacing(dp(2), 1f);
        labels.addView(description, matchWrap(0));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        row.addView(labels, labelParams);

        if (!status.isEmpty()) {
            TextView statusPill = text(status, 12, statusColor, true);
            statusPill.setGravity(Gravity.CENTER);
            statusPill.setPadding(dp(10), dp(6), dp(10), dp(6));
            statusPill.setBackground(roundedBackground(statusBackground, 20, Color.TRANSPARENT, 0));
            row.addView(statusPill, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
        if (onClick != null) {
            row.setClickable(true);
            row.setFocusable(true);
            row.setOnClickListener(onClick);
        }
        return row;
    }

    private void buildTestAlarmScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(28), dp(28), dp(28), dp(28));
        root.setBackgroundColor(COLOR_RED);

        ImageView bell = new ImageView(this);
        bell.setImageResource(R.drawable.ic_notification);
        bell.setColorFilter(Color.WHITE);
        root.addView(bell, new LinearLayout.LayoutParams(dp(82), dp(82)));
        TextView title = text("Test alarm", 32, Color.WHITE, true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = matchWrap(dp(10));
        titleParams.topMargin = dp(28);
        root.addView(title, titleParams);
        TextView description = text("This is how an event alarm looks and feels.", 16, Color.rgb(255, 232, 228), false);
        description.setGravity(Gravity.CENTER);
        root.addView(description, matchWrap(dp(24)));

        Button stop = new Button(this);
        stop.setText("Stop alarm");
        stop.setAllCaps(false);
        stop.setTextSize(17);
        stop.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        stop.setTextColor(COLOR_RED);
        stop.setMinHeight(dp(58));
        stop.setPadding(dp(24), 0, dp(24), 0);
        stop.setBackground(roundedBackground(Color.WHITE, 18, Color.TRANSPARENT, 0));
        root.addView(stop, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(58)));
        stop.setOnClickListener(view -> stopTestAlarm());
        setContentView(root);
    }

    private void startTestAlarm() {
        try {
            ContextCompat.startForegroundService(this, new Intent(this, AlarmPlaybackService.class));
            showingTestAlarm = true;
            testAlarmStartedAt = System.currentTimeMillis();
            scheduleTestAlarmEnd();
            buildScreen();
        } catch (IllegalStateException | SecurityException error) {
            statusMessage = "Could not start the test alarm. Check alarm and notification permissions.";
            statusIsError = true;
            buildScreen();
        }
    }

    private void stopTestAlarm() {
        alarmUiHandler.removeCallbacks(finishTestAlarm);
        stopService(new Intent(this, AlarmPlaybackService.class));
        showingTestAlarm = false;
        testAlarmStartedAt = 0L;
        buildScreen();
    }

    private void scheduleTestAlarmEnd() {
        alarmUiHandler.removeCallbacks(finishTestAlarm);
        long remaining = TEST_ALARM_DURATION_MS - (System.currentTimeMillis() - testAlarmStartedAt);
        if (remaining <= 0L) finishTestAlarm.run();
        else alarmUiHandler.postDelayed(finishTestAlarm, remaining);
    }

    private void confirmDisconnectDevice(String staffId, String headRole) {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Disconnect this device?")
                .setMessage("This phone will stop receiving alerts and event alarms until you connect it again.")
                .setNegativeButton("Keep connected", (dialogInterface, which) -> dialogInterface.dismiss())
                .setPositiveButton("Disconnect device", (dialogInterface, which) -> disconnectDevice(staffId, headRole))
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(COLOR_RED));
        dialog.show();
    }

    private boolean areNotificationsAllowed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        return NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    private void openNotificationSettings() {
        Intent settings = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())
                : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
        startActivity(settings);
    }

    private GradientDrawable roundedBackground(int color, int radius, int strokeColor, int strokeWidth) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(radius));
        if (strokeWidth > 0) background.setStroke(strokeWidth, strokeColor);
        return background;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(8), dp(16), dp(8));
        card.setBackground(roundedBackground(COLOR_SURFACE, 20, COLOR_BORDER, dp(1)));
        card.setElevation(dp(2));
        return card;
    }

    private Button outlineButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTextColor(COLOR_TEXT);
        button.setMinHeight(dp(54));
        button.setPadding(dp(16), 0, dp(16), 0);
        button.setBackground(roundedBackground(COLOR_SURFACE, 16, COLOR_BORDER, dp(1)));
        return button;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("showingTestAlarm", showingTestAlarm);
        outState.putLong("testAlarmStartedAt", testAlarmStartedAt);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        if (logoAnimator != null) logoAnimator.cancel();
        alarmUiHandler.removeCallbacks(finishTestAlarm);
        super.onDestroy();
    }

    private void openConsole() {
        FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
        if (user == null) {
            setStatus("Reconnect this account once to continue to the console without signing in again.", true);
            return;
        }
        setBusy(true, "Opening your signed-in console…");
        user.getIdToken(true)
                .addOnSuccessListener(result -> AUTH_NETWORK.execute(() -> {
                    try {
                        JSONObject account = new JSONObject()
                                .put("staffId", PushRegistrar.savedStaffId(this))
                                .put("headRole", PushRegistrar.savedHeadRole(this));
                        JSONObject handoff = postWorkerJson(
                                "/auth-handoff",
                                account,
                                result.getToken());
                        String handoffCode = handoff.optString("handoffCode", "");
                        if (handoffCode.isEmpty()) throw new IllegalStateException("The sign-in service returned no handoff code.");
                        String target = Uri.parse(CONSOLE_URL).buildUpon()
                                .appendQueryParameter("authHandoff", handoffCode)
                                .build().toString();
                        runOnUiThread(() -> {
                            setBusy(false, "");
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
                        });
                    } catch (Exception error) {
                        runOnUiThread(() -> setStatus(
                                error.getMessage() == null ? "Could not open your signed-in console. Please try again." : error.getMessage(),
                                true));
                    }
                }))
                .addOnFailureListener(error -> setStatus("Could not verify the connected account. Please reconnect this device.", true));
    }

    private JSONObject postWorkerJson(String path, JSONObject body, String idToken) throws Exception {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(PUSH_WORKER_URL + path).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Origin", APP_ORIGIN);
            connection.setRequestProperty("Content-Type", "application/json");
            if (!idToken.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + idToken);
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String responseText = "";
            if (stream != null) {
                try (Scanner scanner = new Scanner(stream, StandardCharsets.UTF_8.name()).useDelimiter("\\A")) {
                    if (scanner.hasNext()) responseText = scanner.next();
                }
            }
            if (status < 200 || status >= 300) {
                throw new IllegalStateException(status == 401
                        ? "Incorrect Staff ID or password."
                        : "Account sign-in failed (" + status + "). Please try again.");
            }
            return new JSONObject(responseText);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void requestPermissionOrConnect(boolean needsLogin) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        if (needsLogin) authenticateAndConnect();
        else refreshConnection(PushRegistrar.savedStaffId(this), PushRegistrar.savedHeadRole(this));
    }

    private void authenticateAndConnect() {
        int accountType = accountTypeInput.getSelectedItemPosition();
        String identifier = staffIdInput.getText().toString().trim();
        String password = passwordInput.getText().toString();
        if (identifier.isEmpty() || password.isEmpty()) {
            setStatus("Enter your account ID/email and password.", true);
            return;
        }
        if (accountType > 0) {
            authenticateHeadAndConnect(accountType, identifier, password);
            return;
        }
        setBusy(true, "Checking employee account…");
        AUTH_NETWORK.execute(() -> {
            try {
                JSONObject credentials = new JSONObject()
                        .put("staffId", identifier)
                        .put("password", password);
                JSONObject result = postWorkerJson("/employee-authenticate", credentials, "");
                String customToken = result.optString("customToken", "");
                String canonicalId = result.optJSONObject("employee") == null
                        ? identifier
                        : result.getJSONObject("employee").optString("staffId", identifier);
                if (customToken.isEmpty()) throw new IllegalStateException("The sign-in service returned no account token.");
                runOnUiThread(() -> FirebaseAuth.getInstance().signInWithCustomToken(customToken)
                        .addOnSuccessListener(user -> refreshConnection(canonicalId, ""))
                        .addOnFailureListener(error -> {
                            setBusy(false, "Could not finish employee sign-in. Please try again.");
                            statusIsError = true;
                            refreshStatusColor();
                        }));
            } catch (Exception error) {
                runOnUiThread(() -> {
                    setBusy(false, error.getMessage() == null ? "Could not verify account. Check your connection and try again." : error.getMessage());
                    statusIsError = true;
                    refreshStatusColor();
                });
            }
        });
    }

    private void authenticateHeadAndConnect(int accountType, String email, String password) {
        String expectedEmail = HEAD_EMAILS[accountType];
        boolean pharmacistAccount = "pharmacist".equals(HEAD_ROLES[accountType]);
        boolean stockAccount = "stock".equals(HEAD_ROLES[accountType]);
        boolean authorizedEmail = stockAccount
                ? expectedEmail.equalsIgnoreCase(email.trim())
                : pharmacistAccount || email.trim().equalsIgnoreCase(expectedEmail);
        if (email.trim().isEmpty() || !authorizedEmail) {
            setStatus("Use the authorized department email for the selected head account.", true);
            return;
        }
        setBusy(true, "Checking department account…");
        FirebaseAuth.getInstance().signInWithEmailAndPassword(email.trim(), password)
                .addOnSuccessListener(result -> {
                    FirebaseUser user = result.getUser();
                    String signedInEmail = user == null ? "" : user.getEmail();
                    boolean authorizedSignedInEmail = stockAccount
                            ? expectedEmail.equalsIgnoreCase(signedInEmail == null ? "" : signedInEmail.trim())
                            : expectedEmail.equalsIgnoreCase(signedInEmail == null ? "" : signedInEmail.trim());
                    if (authorizedSignedInEmail) {
                        refreshConnection("", HEAD_ROLES[accountType]);
                        return;
                    }

                    if (!pharmacistAccount || user == null) {
                        FirebaseAuth.getInstance().signOut();
                        setBusy(false, "This Firebase account is not authorized for the selected department.");
                        statusIsError = true;
                        refreshStatusColor();
                        return;
                    }
                    FirebaseFirestore.getInstance().collection("eventScheduleAdmins")
                            .document(user.getUid()).get()
                            .addOnSuccessListener(profile -> {
                                String profileEmail = profile.getString("email");
                                boolean authorized = profile.exists()
                                        && Boolean.TRUE.equals(profile.getBoolean("active"))
                                        && "pharmacist".equals(profile.getString("role"))
                                        && signedInEmail != null
                                        && signedInEmail.equalsIgnoreCase(profileEmail == null ? "" : profileEmail.trim());
                                if (authorized) {
                                    refreshConnection("", HEAD_ROLES[accountType]);
                                } else {
                                    FirebaseAuth.getInstance().signOut();
                                    setBusy(false, "This Firebase account is not authorized for the Pharmacy schedule.");
                                    statusIsError = true;
                                    refreshStatusColor();
                                }
                            })
                            .addOnFailureListener(error -> {
                                FirebaseAuth.getInstance().signOut();
                                setBusy(false, "Could not verify the Pharmacy admin profile.");
                                statusIsError = true;
                                refreshStatusColor();
                            });
                })
                .addOnFailureListener(error -> {
                    setBusy(false, "Invalid department email or password.");
                    statusIsError = true;
                    refreshStatusColor();
                });
    }

    private void refreshConnection(String staffId, String headRole) {
        setBusy(true, "Registering this phone…");
        setConnectionRefreshing(true);
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    PushRegistrar.Callback callback = (success, message) -> {
                    if (success) {
                        setConnectionRefreshing(false);
                        if (headRole.isEmpty()) PushRegistrar.saveStaffId(this, staffId);
                        else PushRegistrar.saveHeadRole(this, headRole);
                        statusMessage = headRole.isEmpty()
                                ? "Background alarms are enabled for " + staffId + "."
                                : "Department notifications are enabled for " + accountTypeForRole(headRole) + ".";
                        statusIsError = false;
                        buildScreen();
                    } else {
                        setConnectionRefreshing(false);
                        setBusy(false, "Registration failed: " + message);
                        statusIsError = true;
                        refreshStatusColor();
                    }
                    };
                    if (headRole.isEmpty()) PushRegistrar.subscribe(this, staffId, token, callback);
                    else PushRegistrar.subscribeHead(this, headRole, token, callback);
                })
                .addOnFailureListener(error -> {
                    setConnectionRefreshing(false);
                    setBusy(false, "Could not get an FCM token. Check Google Play services and try again.");
                    statusIsError = true;
                    refreshStatusColor();
                });
    }

    private void disconnectDevice(String staffId, String headRole) {
        setBusy(true, "Disconnecting this phone…");
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> PushRegistrar.unsubscribe(this, staffId, headRole, token, (success, message) -> {
                    if (success) {
                        PushRegistrar.clearPairing(this);
                        FirebaseAuth.getInstance().signOut();
                        statusMessage = "This phone is disconnected.";
                        statusIsError = false;
                    } else {
                        statusMessage = "Could not disconnect: " + message;
                        statusIsError = true;
                    }
                    buildScreen();
                }))
                .addOnFailureListener(error -> {
                    PushRegistrar.clearPairing(this);
                    FirebaseAuth.getInstance().signOut();
                    statusMessage = "Local pairing removed. The remote subscription could not be reached.";
                    statusIsError = true;
                    buildScreen();
                });
    }

    private String accountTypeForRole(String headRole) {
        if ("pharmacist".equals(headRole)) return "Operations head";
        if ("billing".equals(headRole)) return "Billing head";
        if ("information".equals(headRole)) return "Information head";
        if ("stock".equals(headRole)) {
            FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
            String email = user == null ? "" : user.getEmail();
            if ("adminstockreqmeds@planetdrugstore.ph".equalsIgnoreCase(email == null ? "" : email.trim())) {
                return "Stock Request Meds Admin";
            }
            if ("adminstockreqsup@planetdrugstore.ph".equalsIgnoreCase(email == null ? "" : email.trim())) {
                return "Stock Request Supplies Admin";
            }
            return "Stock Request admin";
        }
        return "Employee";
    }

    private EditText input(String hint, int type) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setTextSize(16);
        field.setTextColor(COLOR_TEXT);
        field.setHintTextColor(COLOR_MUTED);
        field.setHint(hint);
        field.setInputType(type);
        field.setPadding(dp(14), dp(12), dp(14), dp(12));
        field.setBackground(roundedBackground(COLOR_SURFACE_RAISED, 12, COLOR_BORDER, dp(1)));
        return field;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setTextColor(Color.WHITE);
        button.setMinHeight(dp(56));
        button.setPadding(dp(16), 0, dp(16), 0);
        button.setBackground(roundedBackground(COLOR_RED, 16, Color.TRANSPARENT, 0));
        return button;
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = bottomMargin;
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void setBusy(boolean busy, String message) {
        statusMessage = message;
        statusIsError = false;
        if (connectButton != null) connectButton.setEnabled(!busy);
        if (statusText != null) {
            statusText.setText(message);
            refreshStatusColor();
        }
    }

    private void setStatus(String message, boolean error) {
        statusMessage = message;
        statusIsError = error;
        if (statusText != null) {
            statusText.setText(message);
            refreshStatusColor();
        }
    }

    private void refreshStatusColor() {
        if (statusText != null) statusText.setTextColor(statusIsError ? Color.rgb(176, 31, 31) : Color.rgb(65, 72, 82));
    }
}