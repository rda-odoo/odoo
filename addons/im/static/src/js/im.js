(function() {
    var im = openerp.im = {};

    im.ERROR_DELAY = 30000;

    im.Bus = openerp.Widget.extend({
        init: function(){
            this._super();
            this.options = {};
            this.activated = true;
            this.channels = [];
            this.last = 0;
        },
        poll: function() {
            var self = this;
            self.activated = true;
            var data = {'channels': self.channels, 'last': self.last, 'options' : self.options};
            console.log('poll',  JSON.stringify(data));
            openerp.session.rpc("/longpolling/poll", data, {shadow: true}).then(function(result) {
                _.each(result, _.bind(self.on_notification, self));
                self.poll();
            }, function(unused, e) {
                e.preventDefault();
                self.activated = false;
                setTimeout(_.bind(self.poll, self), im.ERROR_DELAY);
            });
        },
        on_notification: function(notification) {
            var self = this;
            console.log("on_notification", JSON.stringify(notification));
            this.trigger("notification", notification);
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
