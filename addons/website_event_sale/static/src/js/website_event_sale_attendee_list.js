(function (){
    "use strict";
    var website = openerp.website;
    var _t = openerp._t;
    var add_template = website.add_template_file('/website_event_sale/static/src/xml/website_event_sale_attendee_list.xml');
})();
function onchange_ticket_selection(select, ticket_id, ticket_name) {
    selected_item = select.options[select.selectedIndex].value;
    attendee_list = "";
    var res = [];
    if (selected_item != 0) {
        for (var i = 0; i < selected_item; i++) {
            res[i] = i+1;
        }
    }
    var result = {"selected_item": res, "ticket_id": ticket_id, "ticket_name": ticket_name };

    website_event_saleattendee = openerp.Widget.extend({
    template: 'website_event_saleattendee',
    start: function () {
        $('body').append(this.$el);
        console.log(this.$el)
        // var dialog = $(openerp.qweb.render('website_event_saleattendee', {'views': result})).appendTo("body");
        var dialog = $(openerp.qweb.render('website_event_saleattendee', {'views': result}));
        document.querySelector(".js_attendee_fields" + ticket_id).innerHTML = dialog[0].innerHTML;
        },
    });

    $(document).ready(function () {
        var events = new website_event_saleattendee();
        events.start();
    });
}
