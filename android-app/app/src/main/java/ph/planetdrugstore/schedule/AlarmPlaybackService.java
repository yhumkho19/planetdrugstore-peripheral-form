package ph.planetdrugstore.schedule;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

public class AlarmPlaybackService extends Service {
    public static final String ACTION_STOP = "ph.planetdrugstore.schedule.STOP_ALARM";
    private static final int SERVICE_NOTIFICATION_ID = 7201;
    private static final long MAX_ALARM_MS = 60000L;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Ringtone ringtone;
    private long startedAt;

    private final Runnable alarmTick = new Runnable() {
        @Override
        public void run() {
            if (System.currentTimeMillis() - startedAt >= MAX_ALARM_MS) {
                stopAlarm();
                return;
            }
            if (ringtone != null && !ringtone.isPlaying()) ringtone.play();
            handler.postDelayed(this, 1000L);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopAlarm();
            return START_NOT_STICKY;
        }

        NotificationChannels.create(this);
        Notification notification = buildOngoingNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(SERVICE_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification);
        }

        if (ringtone == null) {
            Uri alarmUri = Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.alarm_ring);
            ringtone = RingtoneManager.getRingtone(this, alarmUri);
            if (ringtone == null) {
                alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
                if (alarmUri == null) alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                ringtone = RingtoneManager.getRingtone(this, alarmUri);
            }
            if (ringtone != null && Build.VERSION.SDK_INT >= 21) {
                ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            }
            startedAt = System.currentTimeMillis();
            if (ringtone != null && Build.VERSION.SDK_INT >= 28) ringtone.setLooping(true);
            if (ringtone != null) ringtone.play();
            handler.postDelayed(alarmTick, 1000L);
        }
        return START_NOT_STICKY;
    }

    private Notification buildOngoingNotification() {
        Intent stop = new Intent(this, AlarmPlaybackService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 7202, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, NotificationChannels.ALARM_PLAYBACK)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Event alarm is sounding")
                .setContentText("Tap Stop alarm to silence it.")
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .addAction(R.drawable.ic_notification, "Stop alarm", stopIntent)
                .build();
    }

    private void stopAlarm() {
        handler.removeCallbacks(alarmTick);
        if (ringtone != null) {
            ringtone.stop();
            ringtone = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(alarmTick);
        if (ringtone != null) ringtone.stop();
        ringtone = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}