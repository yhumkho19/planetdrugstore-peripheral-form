package ph.planetdrugstore.schedule;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

public class ScheduleNotificationActionReceiver extends BroadcastReceiver {
    public static final String ACTION_CLOSE = "ph.planetdrugstore.schedule.CLOSE_NOTIFICATION";
    public static final String EXTRA_NOTIFICATION_ID = "notification_id";
    public static final String EXTRA_STOP_ALARM = "stop_alarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_CLOSE.equals(intent.getAction())) return;
        int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0);
        NotificationManagerCompat.from(context).cancel(notificationId);
        if (intent.getBooleanExtra(EXTRA_STOP_ALARM, false)) {
            context.stopService(new Intent(context, AlarmPlaybackService.class));
        }
    }
}