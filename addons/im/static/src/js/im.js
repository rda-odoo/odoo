(function() {
    var im = openerp.im = {};

    im.ERROR_DELAY = 30000;

    im.Bus = openerp.Widget.extend({
        init: function(){
            this._super();
            this.options = {};
            this.activated = false;
            this.channels = [];
            this.last = 0;
        },
        start_polling: function(){
            if(!this.activated){
                this.poll();
            }
        },
        poll: function(){
            var self = this;
            self.activated = true;
            var data = {'channels': self.channels, 'last': self.last, 'options' : self.options};
            console.log("POLL ", data);
            this.request = openerp.jsonRpc('/longpolling/poll', 'call', data).then(function(result) {
                _.each(result, _.bind(self.on_notification, self));
                self.poll();
            }, function(unused, e) {
                //e.preventDefault();
                self.activated = false;
                setTimeout(_.bind(self.poll, self), im.ERROR_DELAY);
            });
        },
        on_notification: function(notification) {
            var self = this;
            var notif_id = notification[0];
            if (notif_id > this.last) {
                this.last = notif_id;
            }
            // trigger the notification without the id, so notif[0] = channel, and notif[1] = message
            this.trigger("notification", [notification[1],notification[2]]);
        },
        add_channel: function(channel){
            if(!_.contains(this.channels, channel)){
                this.channels.push(channel);
            }
        },
        delete_channel: function(channel){
            this.channels = _.without(this.channels, channel);
        },
    });

    // singleton
    im.bus = new im.Bus();
    return im;

})();
