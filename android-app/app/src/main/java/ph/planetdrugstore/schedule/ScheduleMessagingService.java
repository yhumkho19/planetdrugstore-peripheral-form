package ph.planetdrugstore.schedule;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class ScheduleMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        PushRegistrar.syncSaved(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (data.isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;

        NotificationChannels.create(this);
        boolean eventAlarm = "1".equals(data.get("eventReminder"));
        String notificationType = value(data, "notificationType", "");
        boolean pharmacistNote = "pharmacistNote".equals(notificationType);
        boolean stockDayNotification = notificationType.startsWith("stockDay");
        boolean priorityUpdate = pharmacistNote || "removed".equals(notificationType);
        String channel = eventAlarm ? NotificationChannels.EVENT_ALARMS
            : priorityUpdate ? NotificationChannels.PRIORITY_UPDATES : NotificationChannels.UPDATES;
        String title = value(data, "title", eventAlarm ? "Event alarm from Pharmacy" : "Pharmacy schedule update");
        String body = value(data, "body", "Open the schedule to review the update.");
        String url = value(data, "url", "https://planetdrugstoreconsole.web.app/47fto0gim6");
        String id = value(data, "notificationId", String.valueOf(System.currentTimeMillis()));
        int notificationId = id.hashCode() & 0x7fffffff;

        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        PendingIntent contentIntent = PendingIntent.getActivity(this, notificationId, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent close = new Intent(this, ScheduleNotificationActionReceiver.class)
            .setAction(ScheduleNotificationActionReceiver.ACTION_CLOSE)
            .putExtra(ScheduleNotificationActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
            .putExtra(ScheduleNotificationActionReceiver.EXTRA_STOP_ALARM, eventAlarm);
        PendingIntent closeIntent = PendingIntent.getBroadcast(this, notificationId, close,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(eventAlarm ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_EVENT)
                .setVibrate(eventAlarm ? new long[]{0, 180, 100, 180, 100, 360} : new long[]{0, 180, 100, 180});

            notification.addAction(R.drawable.ic_notification, pharmacistNote ? "View notes" : stockDayNotification ? "View page" : "View site", contentIntent)
                .addAction(R.drawable.ic_notification, "Close", closeIntent);

            NotificationManagerCompat.from(this).notify(notificationId, notification.build());

        if (eventAlarm) {
            Intent alarm = new Intent(this, AlarmPlaybackService.class);
            ContextCompat.startForegroundService(this, alarm);
        }
    }

    private String value(Map<String, String> data, String key, String fallback) {
        String value = data.get(key);
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}