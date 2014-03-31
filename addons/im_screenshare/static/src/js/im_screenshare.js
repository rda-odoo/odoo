(function(){
    var instance = openerp;
    instance.screen_record = {};

    instance.screen_record.RecordYourScreen = instance.web.Widget.extend({
        start: function(){
            this.$el.append("<div>You can recod your screen and save it your database by clicking on this button !</div>");
            var button = new instance.screen_record.RecordButton(this);
            button.appendTo(this.$el);
        }
    });

    instance.web.client_actions.add('screen_record.yourscreen', 'instance.screen_record.RecordYourScreen');

    instance.screen_record.RecordHandler = instance.Class.extend({
        init: function() {
            this.treeMirrorClient = null;
            this.cursorMirrorClient = null;
            this.def = $.when();
            this.msgQueue = [];
        },
        send_queue: function(msg) {
            var self = this;
            //console.log(self.msgQueue);
            var msglist = JSON.stringify(self.msgQueue);
            this.def = this.send_record(msglist);
            this.msgQueue = [];
            this.def.then(function(result) {
                if (self.msgQueue.length) {
                    self.send_queue();
                }
            });
        },
        queue: function(msg) {
            this.msgQueue.push(msg);
            if (this.def.state() === "resolved") {
                this.send_queue();
            }
        },
        is_recording: function(){
            return this.treeMirrorClient !== null;
        },
        start_record: function(){
            var self = this;
            this.queue({
                'base': location.href.match(/^(.*\/)[^\/]*$/)[1],
                'timestamp': Date.now(),
            });
            this.treeMirrorClient = new TreeMirrorClient(document.body, {
                initialize: function(rootId, children) {
                    self.queue({
                        f: 'initialize',
                        args: [rootId, children],
                        'timestamp': Date.now(),
                    });
                },
                applyChanged: function(removed, addedOrMoved, attributes, text) {
                    self.queue({
                        f: 'applyChanged',                                    
                        args: [removed, addedOrMoved, attributes, text],
                        'timestamp': Date.now(),
                    });
                }
            });
            this.cursorMirrorClient = new CursorMirrorClient({
                forwardData: function(page, coords, elem) {
                    self.queue({
                        f: 'forwardData',
                        args: [page, coords, elem],
                        'timestamp': Date.now(),
                    });
                },
            });  
        },
        stop_record: function(){
            if(this.is_recording()){
                this.treeMirrorClient.disconnect();
                this.treeMirrorClient = null;
                this.cursorMirrorClient.disconnect();
                this.cursorMirrorClient = null;
            }
        },
        send_record: function(json_mutations){
            return $.Deferred().resolve();
        },
    });

    instance.screen_record.DbRecordHandler = instance.screen_record.RecordHandler.extend({
        start_record: function(){
            //create the record
            var self =  this;
            var date = new Date();
            var screenRecord = new instance.web.Model('screen.record');
            screenRecord.call('create', [{
                'name': 'New Screen Recording Session: ' + date.toString(),
                'starttime': date.toISOString(),
            }]).then(function(result) { 
                self.currentScreenRecord = result;
            });
            // start recording
            this._super();
        },
        stop_record: function(){
            // stop recording
            this._super();
            // save the end time
            var self = this;
            var date = new Date();
            var screenRecord = new instance.web.Model('screen.record');
            screenRecord.call('write', [this.currentScreenRecord, {
                    'endtime': date.toISOString(),
            }]).then(function(result) {
                console.log("Screen Record with id: " + self.currentScreenRecord + " modified");
            }); 
        },
        send_record: function(json_mutations){
            var date = new Date();
            var ts = this.msgQueue[0]['timestamp'];
            var screenRecordEvent = new instance.web.Model('screen.record.event');
            var def = screenRecordEvent.call('create', [{
                    'screen_record_id': this.currentScreenRecord,
                    'timestamp': ts,
                    'timestamp_date': date.toISOString(),
                    'msglist': json_mutations,
            }]);
            return def;
        }
    });


    instance.screen_record.RecordButton = instance.web.Widget.extend({
        init: function(parent){
            this._super();
            this.record_handler = new instance.screen_record.DbRecordHandler();
        },
        start: function() {
            this.$el.html(this.generate_button());
            this.$el.on('click','button',_.bind(this.click,this));
        },
        generate_button: function() {
            return (this.record_handler.is_recording() ? '<button>Stop</button>' : '<button>Record</button>');
        },
        click: function(){
            console.log("Click RecordButton");
            if(this.record_handler.is_recording()){
                 console.log("sTOP RecordButton");
                this.record_handler.stop_record();
            }else{
                 console.log("START RecordButton");
                 this.record_handler.start_record();
            }
            this.$el.html(this.generate_button());
        }
    });

    instance.web.UserMenu.include({
        do_update: function(){
            var self = this;
            this.update_promise.then(function() {
                var button = new instance.screen_record.RecordButton(this);
                button.appendTo(openerp.webclient.$el.find('.oe_systray'));
            });
            return this._super.apply(this, arguments);
        },
    });

    return instance.screen_record;
})();
