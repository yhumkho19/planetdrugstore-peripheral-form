package ph.planetdrugstore.schedule;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

public final class NotificationChannels {
    public static final String UPDATES = "pds_updates_v1";
    public static final String PRIORITY_UPDATES = "pds_priority_updates_v1";
    public static final String EVENT_ALARMS = "pds_event_alarms_v1";
    public static final String ALARM_PLAYBACK = "alarm_playback";

    private NotificationChannels() {}

    public static void create(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel updates = new NotificationChannel(UPDATES, "PDS notifications", NotificationManager.IMPORTANCE_HIGH);
        updates.setDescription("Updates from Planet Drugstore apps, including schedules and stock requests.");
        updates.enableVibration(true);
        updates.setVibrationPattern(new long[]{0, 180, 100, 180});
        updates.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());

        NotificationChannel priorityUpdates = new NotificationChannel(PRIORITY_UPDATES, "Important PDS alerts", NotificationManager.IMPORTANCE_HIGH);
        priorityUpdates.setDescription("Important updates and actions from Planet Drugstore apps.");
        priorityUpdates.enableVibration(true);
        priorityUpdates.setVibrationPattern(new long[]{0, 180, 100, 180});
        priorityUpdates.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());

        NotificationChannel alarms = new NotificationChannel(EVENT_ALARMS, "PDS event alarms", NotificationManager.IMPORTANCE_HIGH);
        alarms.setDescription("Urgent reminders for Pharmacy events.");
        alarms.enableVibration(true);
        alarms.setVibrationPattern(new long[]{0, 180, 100, 180, 100, 360});
        android.net.Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        alarms.setSound(alarmSound, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());

        NotificationChannel playback = new NotificationChannel(ALARM_PLAYBACK, "PDS alarm sound", NotificationManager.IMPORTANCE_LOW);
        playback.setDescription("Ongoing notification while an event alarm is sounding.");
        playback.setSound(null, null);
        playback.enableVibration(false);

        manager.createNotificationChannel(updates);
        manager.createNotificationChannel(priorityUpdates);
        manager.createNotificationChannel(alarms);
        manager.createNotificationChannel(playback);
    }
}