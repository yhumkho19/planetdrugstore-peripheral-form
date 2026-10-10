package ph.planetdrugstore.schedule;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

public final class NotificationChannels {
    public static final String UPDATES = "schedule_updates_v2";
    public static final String PRIORITY_UPDATES = "priority_schedule_updates_v1";
    public static final String EVENT_ALARMS = "event_alarms_v2";
    public static final String ALARM_PLAYBACK = "alarm_playback";

    private NotificationChannels() {}

    public static void create(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel updates = new NotificationChannel(UPDATES, "Schedule updates", NotificationManager.IMPORTANCE_HIGH);
        updates.setDescription("Changes and assignments from the Pharmacy schedule.");
        updates.enableVibration(true);
        updates.setVibrationPattern(new long[]{0, 180, 100, 180});
        updates.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());

        NotificationChannel priorityUpdates = new NotificationChannel(PRIORITY_UPDATES, "Important schedule alerts", NotificationManager.IMPORTANCE_HIGH);
        priorityUpdates.setDescription("Important notes and employee assignment changes from department heads.");
        priorityUpdates.enableVibration(true);
        priorityUpdates.setVibrationPattern(new long[]{0, 180, 100, 180});
        priorityUpdates.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());

        NotificationChannel alarms = new NotificationChannel(EVENT_ALARMS, "Event alarms", NotificationManager.IMPORTANCE_HIGH);
        alarms.setDescription("Urgent reminders for today's Pharmacy events.");
        alarms.enableVibration(true);
        alarms.setVibrationPattern(new long[]{0, 180, 100, 180, 100, 360});
        android.net.Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        alarms.setSound(alarmSound, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());

        NotificationChannel playback = new NotificationChannel(ALARM_PLAYBACK, "Alarm sound", NotificationManager.IMPORTANCE_LOW);
        playback.setDescription("Ongoing notification while an event alarm is sounding.");
        playback.setSound(null, null);
        playback.enableVibration(false);

        manager.createNotificationChannel(updates);
        manager.createNotificationChannel(priorityUpdates);
        manager.createNotificationChannel(alarms);
        manager.createNotificationChannel(playback);
    }
}