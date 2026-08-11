import { EDGE_TYPE_LABELS, type GraphData, type GraphEdge } from '@/lib/types'
import { Icon } from '@/components/ui/Icon'
import {
    RELATION_LENSES,
    relationCss,
    relationEvidence,
    type RelationLens,
} from './graphRelations'

export function StarMapRelationLens({
    value,
    onChange,
}: {
    value: RelationLens
    onChange: (value: RelationLens) => void
}) {
    return (
        <div className="pr-sm-relation-lens" role="group" aria-label="关系透镜">
            <span className="pr-sm-relation-lens-title">
                <Icon name="faders-horizontal" size={13} />
                关系透镜
            </span>
            <div className="pr-sm-relation-lens-scroll">
                {RELATION_LENSES.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        className={`pr-sm-relation-chip${value === item.id ? ' is-active' : ''}`}
                        onClick={() => onChange(item.id)}
                        aria-pressed={value === item.id}
                        title={item.description}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

export function RelationEvidenceCard({
    edge,
    data,
    onClose,
}: {
    edge: GraphEdge
    data: GraphData
    onClose: () => void
}) {
    const source = data.nodes.find((node) => node.id === edge.source)
    const target = data.nodes.find((node) => node.id === edge.target)
    if (!source || !target) return null

    const confidence = edge.confidence === 'EXTRACTED'
        ? '直接标注'
        : edge.confidence === 'AMBIGUOUS'
            ? '需结合史料理解'
            : '内容特征推断'

    return (
        <aside className="pr-sm-edge-evidence" aria-label="关系证据">
            <div className="pr-sm-edge-evidence-heading">
                <span
                    className="pr-sm-edge-evidence-line"
                    style={{ background: relationCss(edge.type) }}
                    aria-hidden
                />
                <span>{EDGE_TYPE_LABELS[edge.type]}</span>
                <button type="button" onClick={onClose} aria-label="关闭关系证据">
                    <Icon name="x" size={14} />
                </button>
            </div>
            <div className="pr-sm-edge-evidence-route">
                <strong>{source.label}</strong>
                <Icon name="arrow-right" size={13} />
                <strong>{target.label}</strong>
            </div>
            <p>{relationEvidence(edge)}</p>
            <span className="pr-sm-edge-evidence-confidence">{confidence}</span>
        </aside>
    )
}
