"""Aggregate valid scores with explicit coverage and native EvalScope output."""




def aggregate(records, planned):
    names = sorted({key for record in records for key in record['scores']})
    return {name: {'mean': sum(values) / len(values) if values else None,
                   'scored': len(values), 'total': planned,
                   'coverage': len(values) / planned if planned else 0}
            for name in names
            for values in [[r['scores'][name]['score'] for r in records
                            if name in r['scores'] and r['scores'][name]['status'] == 'scored']]}


def aggregate_sample_scores(sample_scores, rules):
    """Convert dimension values to native EvalScope aggregates."""
    from evalscope.api.metric import AggScore
    result = []
    for config in rules:
        name = config['dimension']
        values = [s.score.value[name] for s in sample_scores if name in s.score.value]
        if values:
            result.append(AggScore(score=sum(values) / len(values), metric_name=name, aggregation='mean',
                                   num=len(values), metadata={'total': len(sample_scores), 'scored': len(values)}))
    return result
