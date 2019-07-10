"use strict"

const {
    dialogflow,
    BrowseCarousel,
    BrowseCarouselItem,
    Suggestions
} = require("actions-on-google");
const request = require("request");
const functions = require("firebase-functions");

const CONTEXT_INPUT_CONDITION = "input_condition";
const CONTEXT_MORE_EVENTS = "more_events";

const app = dialogflow({ debug: true });

const _hasCondition = (date, prefecture, keyword) => {
    return (!!date && !!prefecture && !!keyword);
};

const _fetchEventsAndReply = (conv, date, prefecture, keyword, start, hasTotalCount) => {
    return _fetchEvents(date, prefecture, keyword, start)
        .then(result => {
            const canBrowsable = conv.screen && conv.surface.capabilities.has('actions.capability.WEB_BROWSER');
            if (result.events.length === 0) {
                conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
                conv.contexts.delete(CONTEXT_MORE_EVENTS);
                delete conv.data.previousCondition;
                conv.ask(`${_createConditionPhrase(date, prefecture, keyword)}予定されていません。他の条件をどうぞ。`);
            } else {
                let msg = hasTotalCount ? `${_createConditionPhrase(date, prefecture, keyword)}${result.resultsAvailable}件予定されています。` : "";
                if (!canBrowsable) {
                    if (result.events.length === 1) {
                        msg += _createEventInformationPhrase(result.events[0]);
                    } else {
                        result.events.forEach((event, index) => {
                            msg += _createEventInformationPhraseWithIndex(start + index, event);
                        });
                    }
                }
                if (_isExistsMoreEvents(result)) {
                    conv.data.previousCondition = {
                        date: date,
                        getState: prefecture,
                        keyword: keyword,
                        result: result
                    };
                    msg += `${start + 3}件目以降に進みますか？それとも他の条件で検索しますか？`;
                    conv.contexts.delete(CONTEXT_INPUT_CONDITION);
                    conv.contexts.set(CONTEXT_MORE_EVENTS, 1);
                    conv.ask(msg);
                    conv.ask(new Suggestions("進む", "他の条件"));
                } else {
                    msg += "他の条件をどうぞ。";
                    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
                    conv.contexts.delete(CONTEXT_MORE_EVENTS);
                    delete conv.data.previousCondition;
                    conv.ask(msg);
                }
                if (canBrowsable) {
                    const items = result.events.map(event => {
                        return new BrowseCarouselItem({
                            title: event.title,
                            url: event.eventUrl,
                            description: `${event.place}\n${_createStartedAtPhrase(event.startedAt)}`,
                            footer: event.series.title
                        });
                    });
                    conv.ask(new BrowseCarousel({
                        items
                    }));
                }
            }
        })
        .catch(error => {
            console.log("error", error);
            conv.close("内部エラーが発生したので、会話を終わります。申し訳ございません。");
        });
};

const _fetchEvents = (date, prefecture, keyword, start) => {
    console.log("date,prefecture,keyword,start", date, prefecture, keyword, start);
    return new Promise((resolve, reject) => {
        let url = `https://connpass.com/api/v1/event/?start=${start}&count=3&order=1`;
        if (date) {
            url += `&ymd=${date.substring(0, 10).replace(/-/g, "")}`;
        }
        const keywords = [];
        if (keyword) {
            keywords.push(keyword);
        }
        if (prefecture) {
            keywords.push(prefecture);
        }
        if (keywords.length !== 0) {
            url += "&keyword=" + keywords.map(x => { return encodeURIComponent(x); }).join(",");
        }
        const headers = {
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": "request_on_nodejs"
        };
        const options = {
            url: url,
            method: "GET",
            headers: headers,
            json: true
        };
        request(options, (error, response, body) => {
            if (error) {
                console.log("error-1");
                reject(error);
            } else if (response.statusCode !== 200) {
                console.log("error-2");
                console.log("statusCode", response.statusCode);
                reject(response.statuscode);
            } else {
                console.log(body.events);
                const events = body.events.map(event => {
                    return {
                        place: event.place,
                        title: event.title,
                        startedAt: event.started_at,
                        eventUrl: event.event_url,
                        series: {
                            url: event.series ? event.series.url : "",
                            title: event.series ? event.series.title : ""
                        }
                    };
                });
                resolve({
                    resultsStart: body.results_start,
                    resultsReturned: body.results_returned,
                    resultsAvailable: body.results_available,
                    events: events
                });
            }
        });
    });
};

const _isExistsMoreEvents = result => {
    return (result.resultsStart - 1) + result.resultsReturned < result.resultsAvailable;
};

const _createStartedAtPhrase = datetime => {
    // datetime = '2018-02-03T09:40:00+09:00'
    const month = Number(datetime.substring(5, 7));
    const day = Number(datetime.substring(8, 10));
    const hour = Number(datetime.substring(11, 13));
    const minute = Number(datetime.substring(14, 16));
    if (minute === 0) {
        return `${month}月${day}日 ${hour}時`;
    } else {
        return `${month}月${day}日 ${hour}時${minute}分`;
    }
};

const _createEventInformationPhraseWithIndex = (index, event) => {
    return `${index}番目の勉強会は、${_createEventInformationPhrase(event)}`;
};

const _createEventInformationPhrase = (event) => {
    const place = event.place;
    const title = event.title;
    const startedAt = _createStartedAtPhrase(event.startedAt);
    let msg = "";
    if (place) {
        msg += `${place}にて、`;
    }
    return `${msg}${title}が、${startedAt}から行われます。`;
};

const _createConditionPhrase = (date, prefecture, keyword) => {
    const result = [];
    if (date) {
        const d = new Date(date);
        result.push(`日付が${d.getMonth() + 1}月${d.getDate()}日`)
    }
    if (prefecture) {
        result.push(`場所が${prefecture}`);
    }
    if (keyword) {
        result.push(`キーワードが${keyword}`);
    }
    return `${result.join("、")}の条件にマッチする勉強会は、`;
};

app.intent("input.welcome", (conv, { date, prefecture, keyword }) => {
    if (_hasCondition(date, prefecture, keyword)) {
        return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
    } else {
        conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
        conv.ask("こんにちは。各地で開催される予定の勉強会について、日付や都道府県名、キーワードによってお探しいたします。条件をどうぞ。");
    }
});

app.intent("input.condition", (conv, { date, prefecture, keyword }) => {
    return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("implicit_invocation", (conv, { date, prefecture, keyword }) => {
    return _fetchEventsAndReply(conv, date, prefecture, keyword, 1, true);
});

app.intent("more_events.continue", conv => {
    const previousCondition = conv.data.previousCondition;
    const date = previousCondition.date;
    const prefecture = previousCondition.getState;
    const keyword = previousCondition.keyword;
    const previousResult = previousCondition.result;
    const start = previousResult.resultsStart + previousResult.resultsReturned;
    return _fetchEventsAndReply(conv, date, prefecture, keyword, start, false);
});

app.intent("more_events.condition", conv => {
    const msg = "他の条件をどうぞ。";
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    delete conv.data.previousCondition;
    conv.ask(msg);
});

app.intent("input.unknown", conv => {
    const msg = [
        "よくわかりませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "よく聞き取れませんでした。いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。",
        "何と言ったのでしょうか？いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
});

app.intent("no_input.condition", conv => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
});

app.intent("no_input.more_events", conv => {
    const msg = [
        "よく聞き取れませんでした。条件を言ってください。",
        "まだそこにいらっしゃいますか？条件をどうぞ。"
    ];
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.contexts.delete(CONTEXT_MORE_EVENTS);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
});

app.intent("more_events.unknown", conv => {
    const msg = [
        "よくわかりませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "よく聞き取れませんでした。続きの勉強会に進みますか？それとも他の条件で探しますか？",
        "何と言ったのでしょうか？続きの勉強会に進みますか？それとも他の条件で探しますか？"
    ];
    conv.contexts.delete(CONTEXT_INPUT_CONDITION);
    conv.contexts.set(CONTEXT_MORE_EVENTS, 1);
    conv.ask(msg[Math.floor(Math.random() * msg.length)]);
});

app.intent("help", conv => {
    conv.contexts.set(CONTEXT_INPUT_CONDITION, 1);
    conv.ask("勉強会の開催情報を探すために、いつ、どこで、どんな勉強会が開催されるのかを条件指定してください。例えば、「明日東京で開催されるJavaScript関連の勉強会を教えて」、というように言ってみてください。");
});

app.intent("quit", conv => {
    conv.close("わかりました。また勉強会を探しに来てくださいね。");
});

exports.connpass = functions.https.onRequest(app);
