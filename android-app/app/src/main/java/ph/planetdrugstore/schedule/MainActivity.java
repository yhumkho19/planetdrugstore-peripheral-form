package ph.planetdrugstore.schedule;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.ArrayAdapter;

import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;

import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.messaging.FirebaseMessaging;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

public class MainActivity extends ComponentActivity {
    private static final String SCHEDULE_URL = "https://planetdrugstoreconsole.web.app/47fto0gim6";
    private static final String STOCK_REQUEST_URL = "https://planetdrugstoreconsole.web.app/h9b4t2zvfe";
    private static final String[] ACCOUNT_TYPES = {
        "Employee", "Pharmacist head", "Billing head", "Information head", "Stock Request admin"
    };
    private static final String[] HEAD_ROLES = {"", "pharmacist", "billing", "information", "stock"};
    private static final String[] HEAD_EMAILS = {
        "", "pharmacistdepart@planetdrugstore.ph", "billingdepart@planetdrugstore.ph",
        "informationdepart@planetdrugstore.ph", "adminstockreq@planetdrugstore.ph"
    };
    private Spinner accountTypeInput;
    private EditText staffIdInput;
    private EditText passwordInput;
    private TextView statusText;
    private Button connectButton;
    private String statusMessage = "";
    private boolean statusIsError;

    private final ActivityResultLauncher<String> notificationPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted) {
                    String staffId = PushRegistrar.savedStaffId(this);
                    String headRole = PushRegistrar.savedHeadRole(this);
                    if (!staffId.isEmpty() || !headRole.isEmpty()) refreshConnection(staffId, headRole);
                    else authenticateAndConnect();
                }
                else setStatus("Allow notifications to receive background schedule alarms.", true);
            });

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FirebaseApp.initializeApp(this);
        NotificationChannels.create(this);
        buildScreen();
    }

    private void buildScreen() {
        String savedId = PushRegistrar.savedStaffId(this);
        String savedHeadRole = PushRegistrar.savedHeadRole(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(246, 247, 249));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(34), dp(24), dp(28));
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(content, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView eyebrow = text("PHARMACY SCHEDULE", 12, Color.rgb(153, 34, 30), true);
        content.addView(eyebrow, matchWrap(dp(12)));
        TextView title = text("Background alarms", 28, Color.rgb(32, 36, 43), true);
        content.addView(title, matchWrap(dp(8)));
        TextView intro = text("Connect your employee or department-head account to get Pharmacy schedule updates and event alarms while the app is closed.", 15, Color.rgb(93, 99, 108), false);
        intro.setGravity(Gravity.CENTER);
        content.addView(intro, matchWrap(dp(28)));

        if (!savedId.isEmpty() || !savedHeadRole.isEmpty()) {
            String connectedAs = !savedHeadRole.isEmpty()
                    ? "Connected as " + accountTypeForRole(savedHeadRole)
                    : "Connected as " + savedId;
            TextView connected = text(connectedAs, 16, Color.rgb(39, 105, 74), true);
            connected.setGravity(Gravity.CENTER);
            content.addView(connected, matchWrap(dp(18)));
            connectButton = button("Refresh notification connection");
            content.addView(connectButton, matchWrap(dp(12)));
            connectButton.setOnClickListener(view -> requestPermissionOrConnect(false));
            Button disconnect = button("Disconnect this device");
            content.addView(disconnect, matchWrap(dp(20)));
            disconnect.setOnClickListener(view -> disconnectDevice(savedId, savedHeadRole));
        } else {
            accountTypeInput = new Spinner(this);
            ArrayAdapter<String> accountTypes = new ArrayAdapter<>(this,
                    android.R.layout.simple_spinner_item, ACCOUNT_TYPES);
            accountTypes.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            accountTypeInput.setAdapter(accountTypes);
            content.addView(accountTypeInput, matchWrap(dp(12)));
            staffIdInput = input("Staff ID", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            content.addView(staffIdInput, matchWrap(dp(12)));
            accountTypeInput.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                @Override
                public void onItemSelected(AdapterView<?> parent, android.view.View view, int position, long id) {
                    boolean isEmployee = position == 0;
                    staffIdInput.setHint(isEmployee ? "Staff ID" : "Department email");
                    staffIdInput.setInputType(isEmployee
                            ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                            : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
                }

                @Override
                public void onNothingSelected(AdapterView<?> parent) {}
            });
            passwordInput = input("Employee password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            content.addView(passwordInput, matchWrap(dp(18)));
            connectButton = button("Enable background alarms");
            content.addView(connectButton, matchWrap(dp(20)));
            connectButton.setOnClickListener(view -> requestPermissionOrConnect(true));
        }

        statusText = text(statusMessage, 13, statusIsError ? Color.rgb(176, 31, 31) : Color.rgb(65, 72, 82), false);
        statusText.setGravity(Gravity.CENTER);
        content.addView(statusText, matchWrap(dp(18)));
        TextView note = text("Event alarms play the Pharmacy ring tone for up to 60 seconds. Tap Stop alarm to silence them.", 13, Color.rgb(113, 118, 126), false);
        note.setGravity(Gravity.CENTER);
        content.addView(note, matchWrap(dp(18)));
        Button openSchedule = button("stock".equals(savedHeadRole) ? "Open stock requests" : "Open employee schedule");
        content.addView(openSchedule, matchWrap(dp(12)));
        String openUrl = "stock".equals(savedHeadRole) ? STOCK_REQUEST_URL : SCHEDULE_URL;
        openSchedule.setOnClickListener(view -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(openUrl))));
        setContentView(scroll);
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
        String staffId = identifier;
        setBusy(true, "Checking employee account…");
        FirebaseFirestore.getInstance().collection("employees")
                .document(staffId.toLowerCase(Locale.ROOT)).get()
                .addOnSuccessListener(document -> {
                    String expectedHash = document.getString("passwordHash");
                    if (!document.exists() || expectedHash == null || !expectedHash.equals(passwordHash(password))) {
                        setBusy(false, "Invalid Staff ID or password.");
                        statusIsError = true;
                        refreshStatusColor();
                        return;
                    }
                    String canonicalId = document.getString("staffId");
                    refreshConnection(canonicalId == null || canonicalId.trim().isEmpty() ? staffId : canonicalId, "");
                })
                .addOnFailureListener(error -> {
                    setBusy(false, "Could not verify account. Check your connection and try again.");
                    statusIsError = true;
                    refreshStatusColor();
                });
    }

    private void authenticateHeadAndConnect(int accountType, String email, String password) {
        String expectedEmail = HEAD_EMAILS[accountType];
        if (!email.trim().equalsIgnoreCase(expectedEmail)) {
            setStatus("Use the authorized department email for the selected head account.", true);
            return;
        }
        setBusy(true, "Checking department account…");
        FirebaseAuth.getInstance().signInWithEmailAndPassword(email.trim(), password)
                .addOnSuccessListener(result -> {
                    String signedInEmail = result.getUser() == null ? "" : result.getUser().getEmail();
                    if (!expectedEmail.equalsIgnoreCase(signedInEmail == null ? "" : signedInEmail.trim())) {
                        FirebaseAuth.getInstance().signOut();
                        setBusy(false, "This Firebase account is not authorized for the selected department.");
                        statusIsError = true;
                        refreshStatusColor();
                        return;
                    }
                    refreshConnection("", HEAD_ROLES[accountType]);
                })
                .addOnFailureListener(error -> {
                    setBusy(false, "Invalid department email or password.");
                    statusIsError = true;
                    refreshStatusColor();
                });
    }

    private void refreshConnection(String staffId, String headRole) {
        setBusy(true, "Registering this phone…");
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    PushRegistrar.Callback callback = (success, message) -> {
                    if (success) {
                        if (headRole.isEmpty()) PushRegistrar.saveStaffId(this, staffId);
                        else PushRegistrar.saveHeadRole(this, headRole);
                        statusMessage = headRole.isEmpty()
                                ? "Background alarms are enabled for " + staffId + "."
                                : "Department notifications are enabled for " + accountTypeForRole(headRole) + ".";
                        statusIsError = false;
                        buildScreen();
                    } else {
                        setBusy(false, "Registration failed: " + message);
                        statusIsError = true;
                        refreshStatusColor();
                    }
                    };
                    if (headRole.isEmpty()) PushRegistrar.subscribe(this, staffId, token, callback);
                    else PushRegistrar.subscribeHead(this, headRole, token, callback);
                })
                .addOnFailureListener(error -> {
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
                        if (!headRole.isEmpty()) FirebaseAuth.getInstance().signOut();
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
                    if (!headRole.isEmpty()) FirebaseAuth.getInstance().signOut();
                    statusMessage = "Local pairing removed. The remote subscription could not be reached.";
                    statusIsError = true;
                    buildScreen();
                });
    }

    private String accountTypeForRole(String headRole) {
        if ("pharmacist".equals(headRole)) return "Pharmacist head";
        if ("billing".equals(headRole)) return "Billing head";
        if ("information".equals(headRole)) return "Information head";
        if ("stock".equals(headRole)) return "Stock Request admin";
        return "Employee";
    }

    private String passwordHash(String password) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(password.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte value : digest) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            return result.toString();
        } catch (Exception error) {
            return "";
        }
    }

    private EditText input(String hint, int type) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setTextSize(16);
        field.setHint(hint);
        field.setInputType(type);
        field.setPadding(dp(14), dp(12), dp(14), dp(12));
        field.setBackgroundColor(Color.WHITE);
        return field;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(183, 25, 22)));
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